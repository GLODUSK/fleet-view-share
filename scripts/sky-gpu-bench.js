// The map sky's GPU bench: what each sky event costs the GPU, against Henry's budget (2026-10-15: the sky's sights may
// look better only while Fleet View stays under 5% of the GPU). Step 1 of the sky upgrades: every later change is
// checked with this, not guessed.
//
//   node scripts/sky-gpu-bench.js [--checkout <dir>] [--size 3840x2160] [--seconds 8] [--budget 5] [--out results.json]
//        [--only planet,siege,...] [--prof <edge profile dir>] [--port 4797] [--wait 1500]
//   node scripts/sky-gpu-bench.js --live [--seconds 8] [--budget 5] [--out results.json]
//   node scripts/sky-gpu-bench.js --attach <debugging port> [--seconds 8] [--budget 5] [--out results.json] [--only ...]
//
// Bench (Windows): boots a demo server from the checkout (default: this one) on a free port with a temp LOCALAPPDATA
// (never Henry's data; it checks /state's home is null before anything else), starts headless Edge on the real GPU
// (--size, device scale 1) with a profile kept under B:\Temp (a cold compile of the sky's shader took ~17 min on D3D11 in
// 2026-10, and headless Edge relinks it every run even with its cache written; it waits up to --wait seconds, default
// 1500, for stats().sky 'webgl2' with the full program linked, stats().rects.full), opens the Map tab (?fixture=1, so window.__map is there), keeps the page
// awake (__map.rest(false)), holds the director (__map.hold(true): nothing starts by itself), turns the GPU meter on
// (__map.gpuMeter(true), web/map.js: the sky's passes timed with EXT_disjoint_timer_query_webgl2) and then runs, one at a
// time: the empty sky (baseline), each space event (__map.event()), each scene (__map.scene()) and each far event
// (__map.far()), each skipped into its middle so it is on screen, for --seconds each. Per row: the sky pass's GPU ms, sky
// passes a second, the sky's GPU ms a second (/10 = its share of the GPU in %), the map's frames a second, and Windows'
// own number: the 3D engine's utilisation of the headless browser's GPU process (\GPU Engine(pid_<gpu>*engtype_3D)\
// Utilization Percentage, summed per sample, averaged), its change against the baseline, and PASS or OVER --budget (%).
// The empty sky is measured again at the end, to show the drift. Ends the Edge and the server it started (by pid) and
// nothing else.
//
// Not the real window: headless renders the page offscreen at --size, at its own frame rate, with no acrylic window or
// desktop compositor; the real window (desktop/) also draws the map's 2D canvas over the sky at the screen's refresh.
// Use the rows to compare events with each other and with the baseline; --live gives the whole-app number.
//
// --attach <port>: the same rows in a window already running with --remote-debugging-port=<port> (a test Fleet View
// window on its own port and profile, say, to see the real window's numbers: acrylic, compositor, refresh), its page
// opened with ?fixture=1 or ?debug=1. Nothing is started, navigated, resized or ended; its GPU process is the one the
// process listening on that port started.
//
// --live: the running Fleet View as it is, no event control: on Windows the 3D utilisation of its GPU process (the
// `--type=gpu-process` one whose path is under fleet-view\desktop); on the Mac the whole GPU's "Device Utilization %"
// (ioreg -c IOAccelerator: no sudo, so it counts every app; the rest of the Mac should be quiet). On the Mac node is
// not on PATH over SSH: ELECTRON_RUN_AS_NODE=1 "/Users/henry/Applications/Fleet View.app/Contents/MacOS/Electron"
// scripts/sky-gpu-bench.js --live
'use strict';
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const argv = process.argv.slice(2), opt = {};
for (let i = 0; i < argv.length; i++) {
  if (!argv[i].startsWith('--')) continue;
  const k = argv[i].slice(2);
  opt[k] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
}
const SECONDS = Math.max(2, Number(opt.seconds) || 8), BUDGET = Number(opt.budget) || 5, WAIT = Number(opt.wait) || 1500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const r2 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);
const mean = (a) => { const v = a.filter((x) => x != null && Number.isFinite(x)); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; };

// a PowerShell script run hidden, its output as text (EncodedCommand: no quoting trouble)
function ps(script, timeout = 60e3) {
  return new Promise((resolve) => {
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', () => {});
    const t = setTimeout(() => { try { p.kill(); } catch {} }, timeout);
    p.on('close', () => { clearTimeout(t); resolve(out); });
  });
}
// Windows: the 3D engine's utilisation of process `pid`, one sum a second for n seconds; their average and the samples
async function winGpu(pid, n) {
  const out = await ps(`$c = '\\GPU Engine(pid_${pid}_*engtype_3D)\\Utilization Percentage'
try { Get-Counter -Counter $c -SampleInterval 1 -MaxSamples ${n} -ErrorAction Stop | ForEach-Object { [string]::Format([Globalization.CultureInfo]::InvariantCulture, '{0}', ($_.CounterSamples | Measure-Object CookedValue -Sum).Sum) } } catch { 'ERR ' + $_.Exception.Message }`, (n + 30) * 1000);
  const lines = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const err = lines.find((s) => s.startsWith('ERR '));
  const samples = lines.filter((s) => !s.startsWith('ERR ')).map(Number).filter(Number.isFinite);
  return { pct: samples.length ? mean(samples) : null, samples: samples.map(r2), err: err ? err.slice(4) : null };
}
// Mac: the whole GPU's Device Utilization % (ioreg), once a second for n seconds
async function macGpu(n) {
  const samples = [];
  for (let i = 0; i < n; i++) {
    try {
      const out = execFileSync('ioreg', ['-r', '-d', '1', '-w', '0', '-c', 'IOAccelerator'], { encoding: 'utf8' });
      const m = out.match(/"Device Utilization %"\s*=\s*(\d+)/);
      if (m) samples.push(Number(m[1]));
    } catch { /* one missed sample */ }
    await sleep(1000);
  }
  return { pct: samples.length ? mean(samples) : null, samples, err: samples.length ? null : 'no "Device Utilization %" in ioreg' };
}
function writeOut(data) {
  if (!opt.out || opt.out === true) return;
  fs.mkdirSync(path.dirname(path.resolve(opt.out)), { recursive: true });
  fs.writeFileSync(opt.out, JSON.stringify(data, null, 1));
  console.log(`results: ${path.resolve(opt.out)}`);
}

// ---------- --live ----------
async function live() {
  const at = new Date().toISOString();
  if (process.platform === 'darwin') {
    let running = false;
    try { running = /Fleet View\.app\/Contents\/MacOS/.test(execFileSync('ps', ['-A', '-o', 'command='], { encoding: 'utf8' })); } catch {}
    console.log(`Mac, live, ${SECONDS} s: the whole GPU (ioreg Device Utilization %); Fleet View ${running ? 'is' : 'is NOT'} running`);
    const g = await macGpu(SECONDS);
    const pass = g.pct != null && g.pct <= BUDGET;
    console.log(`GPU ${g.pct == null ? '-' : r2(g.pct) + ' %'} (samples ${g.samples.join(', ')})  ${g.pct == null ? g.err : pass ? 'PASS' : 'OVER'} (budget ${BUDGET} %)`);
    writeOut({ mode: 'live', platform: 'darwin', at, seconds: SECONDS, budget: BUDGET, fleetView: running, gpuPct: r2(g.pct), samples: g.samples, pass, note: 'whole GPU, every app' });
    return;
  }
  if (process.platform !== 'win32') { console.log('--live runs on Windows or the Mac'); process.exit(2); }
  const out = await ps(`Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match '--type=gpu-process' -and $_.ExecutablePath -match 'fleet-view\\\\desktop' } | ForEach-Object { "$($_.ProcessId)" }`);
  const pids = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).map(Number);
  if (!pids.length) { console.log('no running Fleet View window (no gpu-process under fleet-view\\desktop)'); process.exit(1); }
  console.log(`PC, live, ${SECONDS} s: Fleet View's GPU process ${pids.join(', ')} (3D engine utilisation)`);
  const rows = [];
  for (const pid of pids) {
    const g = await winGpu(pid, SECONDS);
    const pass = g.pct != null && g.pct <= BUDGET;
    console.log(`pid ${pid}: GPU ${g.pct == null ? '-' : r2(g.pct) + ' %'} (samples ${g.samples.join(', ')})  ${g.pct == null ? g.err : pass ? 'PASS' : 'OVER'} (budget ${BUDGET} %)`);
    rows.push({ pid, gpuPct: r2(g.pct), samples: g.samples, pass, err: g.err });
  }
  writeOut({ mode: 'live', platform: 'win32', at, seconds: SECONDS, budget: BUDGET, rows });
}

// ---------- the bench ----------
// whether anyone listens on that port (Windows: Get-NetTCPConnection)
async function portBusy(p) {
  const out = await ps(`if (Get-NetTCPConnection -LocalPort ${p} -ErrorAction SilentlyContinue) { 'busy' } else { 'free' }`);
  return !/free/.test(out);
}
async function freePort(from) {
  for (let p = from; p < from + 40; p++) if (!(await portBusy(p))) return p;
  throw new Error(`no free port from ${from}`);
}

async function bench() {
  if (process.platform !== 'win32') { console.log('the bench runs on Windows (headless Edge, Windows GPU counters); on the Mac use --live'); process.exit(2); }
  const checkout = path.resolve(opt.checkout && opt.checkout !== true ? opt.checkout : path.join(__dirname, '..'));
  let [W, H] = String(opt.size && opt.size !== true ? opt.size : '3840x2160').split('x').map(Number);
  const prof = path.resolve(opt.prof && opt.prof !== true ? opt.prof : 'B:/Temp/fvedge-gpubench');
  const only = opt.only && opt.only !== true ? new Set(String(opt.only).split(',')) : null;
  const kids = [];
  const killAll = () => { for (const p of kids.splice(0)) { try { execFileSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} } };
  process.on('exit', killAll);
  process.on('SIGINT', () => { killAll(); process.exit(130); });
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'fv-gpubench-'));
  try {
    // --attach: a window already running with --remote-debugging-port (a test Electron window, say), as it is: its
    // page with the map's tests (?fixture=1 or ?debug=1); no server or Edge is started, the page is not navigated or resized
    const attach = opt.attach && opt.attach !== true ? Number(opt.attach) : null;
    let page = null, port = null;
    if (attach) {
      const targets = await (await fetch(`http://127.0.0.1:${attach}/json`)).json();
      page = targets.find((t) => t.type === 'page' && /[?&](fixture|debug)(=|&|$)/.test(t.url));
      if (!page) throw new Error(`no page with ?fixture=1 or ?debug=1 on the debugging port ${attach}`);
    } else {
      // the demo server
      port = await freePort(Number(opt.port) || 4797);
      const srv = spawn(process.execPath, ['fleet-view.js', '--web', '--demo', '--no-open', '--port', String(port)], {
        cwd: checkout, env: { ...process.env, LOCALAPPDATA: scratch }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      });
      kids.push(srv);
      let srvOut = '';
      srv.stdout.on('data', (d) => { srvOut += d; });
      srv.stderr.on('data', (d) => { srvOut += d; });
      let up = false;
      for (let i = 0; i < 60 && !up; i++) {
        await sleep(500);
        try {
          const r = await fetch(`http://127.0.0.1:${port}/state`), j = await r.json();
          if (j.home) throw Object.assign(new Error(`the server on ${port} is not a demo (its /state has a home): stopping`), { fatal: true });
          up = r.ok;
        } catch (e) { if (e.fatal) throw e; }
      }
      if (!up) throw new Error('the demo server did not start\n' + srvOut.slice(-2000));

      // headless Edge on the real GPU
      const edge = [
        path.join(process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        path.join(process.env.ProgramFiles || 'C:/Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      ].find((p) => fs.existsSync(p));
      if (!edge) throw new Error('no msedge.exe');
      const cdp = await freePort(Number(opt.cdp) || 9411);
      fs.mkdirSync(prof, { recursive: true });
      const br = spawn(edge, ['--headless=new', `--remote-debugging-port=${cdp}`, `--user-data-dir=${prof}`, `--window-size=${W},${H}`,
        '--force-device-scale-factor=1', '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore', windowsHide: true });
      kids.push(br);
      let targets = null;
      for (let i = 0; i < 60 && !targets; i++) { await sleep(300); try { targets = await (await fetch(`http://127.0.0.1:${cdp}/json`)).json(); } catch {} }
      page = targets && targets.find((t) => t.type === 'page');
      if (!page) throw new Error('headless Edge gave no page');
    }
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.addEventListener('open', r, { once: true }); ws.addEventListener('error', j, { once: true }); });
    let id = 0;
    const waits = new Map(), problems = [];
    ws.addEventListener('message', (m) => {
      const d = JSON.parse(m.data);
      if (d.id && waits.has(d.id)) { waits.get(d.id)(d); waits.delete(d.id); return; }
      if (d.method === 'Runtime.exceptionThrown') problems.push('exception: ' + JSON.stringify(d.params.exceptionDetails).slice(0, 600));
    });
    const send = (method, params = {}) => new Promise((r) => { const i = ++id; waits.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
    const ev = async (expr) => {
      const r = (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result;
      if (r && r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 800));
      return r && r.result ? r.result.value : undefined;
    };
    await send('Runtime.enable'); await send('Page.enable');
    if (!attach) {
      await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
      await send('Page.navigate', { url: `http://127.0.0.1:${port}/?fixture=1` });
    } else [W, H] = await ev('[Math.round(innerWidth * devicePixelRatio), Math.round(innerHeight * devicePixelRatio)]');
    for (let i = 0; i < 60 && !(await ev('!!(window.__map && document.querySelector(\'.tabs button[data-view="map"]\'))').catch(() => false)); i++) await sleep(500);
    await ev(`document.querySelector('.tabs button[data-view="map"]').click()`);
    await ev('__map.rest(false)');
    const c0 = Date.now();
    let sky = null;
    // (the WebGL sky draws before its full program is linked, without a warp or voyage; the rows want it linked)
    while ((sky = await ev('(() => { const s = __map.stats(); return s && s.sky === "webgl2" && s.rects && s.rects.full === false ? "linking" : s && s.sky; })()')) !== 'webgl2' && Date.now() - c0 < WAIT * 1000) await sleep(2000);
    console.log(`sky: ${sky} after ${Math.round((Date.now() - c0) / 1000)} s (${attach ? `attached to :${attach}` : `profile ${prof}`})`);
    if (sky !== 'webgl2') throw new Error(`the sky never went to WebGL2 in ${WAIT} s (a cold shader compile takes many minutes; try a longer --wait)\n` + problems.join('\n'));

    // the headless browser's GPU process: the one with this profile on its command line; attached, the GPU process
    // started by the process that listens on the debugging port
    const base = path.basename(prof).replace(/'/g, "''");
    const gp = (await ps(attach
      ? `$o = (Get-NetTCPConnection -LocalPort ${attach} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess; if ($o) { Get-CimInstance Win32_Process -Filter "ParentProcessId=$o" | Where-Object { $_.CommandLine -match '--type=gpu-process' } | ForEach-Object { "$($_.ProcessId)" } }`
      : `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -match '--type=gpu-process' -and $_.CommandLine -like '*${base}*' } | ForEach-Object { "$($_.ProcessId)" }`)).split(/\r?\n/).map((s) => s.trim()).filter(Boolean).map(Number);
    const gpuPid = gp[0] || null;
    console.log(`${attach ? 'the window' : 'headless Edge'}'s GPU process: ${gpuPid || 'not found (no Windows GPU %)'}`);

    const info = await ev(`(() => {
      __map.hold(true); __map.gpuMeter(true);
      // stop everything, then a few frames for the sky to draw without it
      window.__bench = {
        clear: async () => { __map.scene(null); __map.event(null); __map.far(null); await new Promise((r) => setTimeout(r, 1500)); },
        // n one-second samples of the meter and the frame rate
        sample: async (n) => { const out = []; for (let i = 0; i < n; i++) { await new Promise((r) => setTimeout(r, 1000)); const s = __map.stats();
          out.push({ gpu: s.gpu, fps: s.fps, events: s.event.running, scene: s.scene && s.scene.name, far: s.far.running }); } return out; },
      };
      let ren = '';
      try { const gl = __map.skyGL(), e = gl.getExtension('WEBGL_debug_renderer_info'); ren = String(gl.getParameter(e ? e.UNMASKED_RENDERER_WEBGL : gl.RENDERER)); } catch {}
      return { events: __map.event(), scenes: __map.scene(), far: __map.far(), renderer: ren };
    })()`);
    console.log(`renderer: ${info.renderer}`);
    await sleep(1500);
    const g0 = await ev('__map.stats().gpu');
    console.log(`GPU timer (EXT_disjoint_timer_query_webgl2): ${g0.ext ? 'yes' : 'NOT available: only Windows GPU % and CPU ms'}`);

    // the runs: [label, kind, name]
    const runs = [['baseline', 'none', null]];
    for (const n of info.events) runs.push([n, 'event', n]);
    for (const n of info.scenes) runs.push(['scene ' + n, 'scene', n]);
    for (const n of info.far) runs.push(['far ' + n, 'far', n]);
    runs.push(['baseline (end)', 'none', null]);
    const todo = runs.filter(([label, kind, name]) => kind === 'none' || !only || only.has(name) || only.has(label));
    const rows = [];
    for (const [label, kind, name] of todo) {
      await ev('__bench.clear()');
      // start it, read its length, start it again that far in that it stays up the whole sample
      let life = null, ok = true;
      const need = (SECONDS + 3) * 1000, J = JSON.stringify(name);
      if (kind === 'event') {
        ok = await ev(`__map.event(${J}, 0)`);
        const total = ok ? ((await ev('__map.stats().event.life'))[name] || [])[1] : null;
        const skip = total ? Math.max(0, Math.min(0.35 * total, total - need)) / 1000 : 0;
        if (ok && skip > 0) ok = await ev(`__map.event(${J}, ${skip})`);
        life = { ms: total || null, skip: r2(skip) };
      } else if (kind === 'scene') {
        ok = await ev(`__map.scene(${J}, 0)`);
        const sc = ok ? await ev('__map.stats().scene') : null, total = sc && sc.ms;
        const skip = total ? Math.max(0, Math.min(0.4 * total, total - need)) / 1000 : 8;
        if (ok) { await ev('__map.scene(null); __map.event(null)'); ok = await ev(`__map.scene(${J}, ${skip})`); }
        life = { ms: total || null, skip: r2(skip) };
      } else if (kind === 'far') {
        ok = await ev(`__map.far(${J}, 0)`);
        const total = ok ? (await ev('__map.stats().far')).ms : null;
        const skip = total ? Math.max(0, Math.min(0.4 * total, total - need)) / 1000 : 0;
        if (ok && skip > 0) { await ev('__map.far(null)'); ok = await ev(`__map.far(${J}, ${skip})`); }
        life = { ms: total || null, skip: r2(skip), short: !!(total && total < need) };
      }
      if (!ok) { console.log(`${label}: did not start`); rows.push({ label, kind, name, failed: true }); continue; }
      await sleep(1000);
      const [smp, win] = await Promise.all([ev(`__bench.sample(${SECONDS})`), gpuPid ? winGpu(gpuPid, SECONDS) : Promise.resolve({ pct: null, samples: [] })]);
      const last = smp[smp.length - 1];
      const row = {
        label, kind, name, life,
        gpuMs: r2(last.gpu.ms), glowMs: r2(last.gpu.glowMs), passes: r2(mean(smp.map((s) => s.gpu.passes))), msPerS: r2(mean(smp.map((s) => s.gpu.msPerS))),
        cpuMs: r2(last.gpu.cpuMs), fps: r2(mean(smp.map((s) => s.fps))), winPct: r2(win.pct), winSamples: win.samples, lost: last.gpu.lost,
        // what was up at the end (a sight that ended mid-sample shows here)
        up: { events: last.events, scene: last.scene, far: last.far },
      };
      rows.push(row);
      console.log(`  ${label}: ${row.gpuMs} ms/pass, ${row.msPerS} ms/s, ${row.fps} fps, GPU ${row.winPct} %`);
    }
    await ev('__bench.clear()');
    // an attached window goes on as it was
    if (attach) await ev('__map.hold(false); __map.gpuMeter(false); __map.rest(null)');

    // the table
    const base0 = rows.find((r) => r.label === 'baseline');
    const pct = (r) => (r.winPct != null ? r.winPct : r.msPerS != null ? r.msPerS / 10 : null);
    for (const r of rows) {
      if (r.failed) continue;
      r.deltaPct = base0 && pct(r) != null && pct(base0) != null ? r2(pct(r) - pct(base0)) : null;
      r.deltaMsPerS = base0 && r.msPerS != null && base0.msPerS != null ? r2(r.msPerS - base0.msPerS) : null;
      r.pass = pct(r) != null ? pct(r) <= BUDGET : null;
    }
    const cols = [['event', 24], ['gpu ms/pass', 12], ['passes/s', 9], ['sky ms/s', 9], ['fps', 6], ['GPU %', 7], ['delta %', 8], ['delta ms/s', 11], ['', 5], ['up at the end', 30]];
    const line = (vals) => vals.map((v, i) => String(v == null ? '-' : v).padEnd(cols[i][1])).join(' ');
    console.log(`\nSky GPU bench: ${W}x${H}, ${SECONDS} s each, budget ${BUDGET} % (${info.renderer})`);
    console.log(line(cols.map((c) => c[0])));
    for (const r of rows) {
      if (r.failed) { console.log(line([r.label, 'did not start'])); continue; }
      const up = [...r.up.events, r.up.scene && 'scene ' + r.up.scene, r.up.far && 'far ' + r.up.far].filter(Boolean).join(', ') || 'nothing';
      console.log(line([r.label, r.gpuMs, r.passes, r.msPerS, r.fps, r.winPct, r.deltaPct, r.deltaMsPerS, r.pass == null ? '?' : r.pass ? 'PASS' : 'OVER', up]));
    }
    console.log(`GPU %: Windows, 3D engine of the ${attach ? "window's" : 'headless'} GPU process (whole page); sky ms/s: the timer, the sky shader only (/10 = %).`);
    if (problems.length) console.log('page problems:\n' + problems.join('\n'));
    writeOut({ mode: 'bench', at: new Date().toISOString(), checkout, size: [W, H], seconds: SECONDS, budget: BUDGET, renderer: info.renderer, timer: !!g0.ext, gpuPid, rows, problems });
    try { ws.close(); } catch {}
  } finally {
    killAll();
    try { fs.rmSync(scratch, { recursive: true, force: true }); } catch {}
  }
}

(opt.live ? live() : bench()).then(() => process.exit(0), (e) => { console.log('sky-gpu-bench failed: ' + (e && e.stack ? e.stack : e)); process.exit(1); });
