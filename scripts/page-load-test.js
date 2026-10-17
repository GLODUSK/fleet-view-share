// page-load-test.js: the page loads, without a browser. A --demo server on a free port with its own data folder serves
// web/; for each page (/, /mini.html, /pair.html):
//   - it answers 200, and has no inline <script> (the page's Content-Security-Policy would block it)
//   - every <script src> and <link rel="stylesheet" href> it names answers 200 and is not empty
//   - its classic scripts parse (vm.Script)
// Every web/*.js module (the ones the pages load, and the ones loaded later with import() or cards.js loadModule) is
// fetched from the server and linked with its imports (vm.SourceTextModule, nothing run): a syntax error, an import of
// a file that is not there or of a name the module does not export fails here, where in the browser it blanks the page.
// The import() and loadModule('x.js') names in them must be files in web/. Every web/*.css has its braces balanced
// (comments and strings left out) and no stray text after the last rule.
// Run: node scripts/page-load-test.js (exit 0 = all pass). It starts itself again with --experimental-vm-modules.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { spawn, spawnSync } = require('child_process');

if (!vm.SourceTextModule) {
  const r = spawnSync(process.execPath, ['--experimental-vm-modules', '--no-warnings', __filename, ...process.argv.slice(2)], { stdio: 'inherit', windowsHide: true });
  process.exit(r.status === null ? 1 : r.status);
}

const TS = require('./test-support.js');
const WEB = path.join(__dirname, '..', 'web');
let pass = 0, fail = 0;
const ok = (c, n) => { if (c) pass++; else { fail++; console.log(`FAIL ${n}`); } };

// a CSS file's text without its comments and strings: braces balanced, never closed before opened, nothing after the
// last rule but white space
function cssProblem(text) {
  const s = text.replace(/\/\*[\s\S]*?(?:\*\/|$)/g, ' ').replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g, '""');
  let depth = 0, line = 1;
  for (const ch of s) {
    if (ch === '\n') line++;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth < 0) return `a } with no { (line ${line})`;
  }
  if (depth) return `${depth} { left open at the end`;
  const tail = s.slice(s.lastIndexOf('}') + 1).trim();
  return tail && !/^@(?:import|charset)\b[^;{}]*;$/.test(tail) && s.includes('}') ? `text after the last rule: ${tail.slice(0, 60)}` : null;
}

(async () => {
  // the stylesheets, from disk (some are loaded by the page's scripts, not named in a page)
  for (const f of fs.readdirSync(WEB).filter((n) => n.endsWith('.css'))) {
    const why = cssProblem(fs.readFileSync(path.join(WEB, f), 'utf8'));
    ok(!why, `web/${f}: ${why}`);
  }

  const port = await TS.freePort(), origin = `http://127.0.0.1:${port}`;
  const data = fs.mkdtempSync(path.join(process.env.FV_TEST_TMP || os.tmpdir(), 'fv-page-load-'));
  const env = { ...process.env, LOCALAPPDATA: data, HOME: data, USERPROFILE: data, XDG_STATE_HOME: data };
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'fleet-view.js'), '--demo', '--port', String(port), '--no-open'], { env, stdio: 'ignore', windowsHide: true });
  const get = async (p) => { try { const r = await fetch(origin + p, { signal: AbortSignal.timeout(20000) }); return { code: r.status, type: r.headers.get('content-type') || '', text: await r.text() }; } catch (e) { return { code: 0, type: '', text: '', err: e.message }; } };
  try {
    let up = false;
    for (let i = 0; i < 120 && !up; i++) { up = (await get('/state')).code === 200; if (!up) await new Promise((r) => setTimeout(r, 500)); }
    ok(up, 'the demo server answers /state');
    if (!up) return;

    // ---------- the pages and what they name ----------
    const classic = new Set();
    for (const page of ['/', '/mini.html', '/pair.html']) {
      const r = await get(page);
      ok(r.code === 200 && /text\/html/.test(r.type), `${page}: 200 text/html (${r.code} ${r.type})`);
      const html = r.text;
      for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
        const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(m[1]);
        if (!src) { ok(!m[2].trim(), `${page}: an inline <script> (the Content-Security-Policy blocks it): ${m[2].trim().slice(0, 60)}`); continue; }
        const url = new URL(src[1], origin + page).pathname;
        const s = await get(url);
        ok(s.code === 200 && s.text.trim(), `${page}: <script src="${src[1]}"> answers 200 with a body (${s.code})`);
        if (/\btype\s*=\s*["']module["']/i.test(m[1])) continue; // linked below, with every other module
        classic.add(url);
        if (s.code !== 200) continue;
        try { new vm.Script(s.text, { filename: url }); ok(true); } catch (e) { ok(false, `${page}: ${src[1]} does not parse: ${e.message}`); }
      }
      for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
        if (!/\brel\s*=\s*["']stylesheet["']/i.test(m[0])) continue;
        const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(m[0]);
        if (!href || /^(?:data:|https?:)/i.test(href[1])) continue;
        const s = await get(new URL(href[1], origin + page).pathname);
        ok(s.code === 200 && /text\/css/.test(s.type) && s.text.trim(), `${page}: <link href="${href[1]}"> answers 200 text/css with a body (${s.code} ${s.type})`);
      }
    }

    // ---------- every module, linked with its imports ----------
    const cache = new Map(); // url path -> Promise of a SourceTextModule (or an Error)
    const ctx = vm.createContext({});
    const load = (p) => {
      if (!cache.has(p)) cache.set(p, (async () => {
        const r = await get(p);
        if (r.code !== 200) return new Error(`${p}: ${r.code || r.err}`);
        try { return new vm.SourceTextModule(r.text, { identifier: p, context: ctx, initializeImportMeta() {}, importModuleDynamically() {} }); } catch (e) { return new Error(`${p} does not parse: ${e.message}`); }
      })());
      return cache.get(p);
    };
    const linker = async (spec, from) => {
      const m = await load(new URL(spec, origin + from.identifier).pathname);
      if (m instanceof Error) throw m;
      return m;
    };
    const modules = fs.readdirSync(WEB).filter((n) => n.endsWith('.js') && !classic.has(`/${n}`)).sort();
    ok(modules.length > 10, `web/ has its modules (${modules.length})`);
    for (const n of modules) {
      const m = await load(`/${n}`);
      if (m instanceof Error) { ok(false, `web/${n}: ${m.message}`); continue; }
      try { if (m.status === 'unlinked') await m.link(linker); ok(true); } catch (e) { ok(false, `web/${n} does not link: ${e.message}`); }
      // what it loads later: import('./x.js') and cards.js loadModule('x.js') (the vendor/ ones are vendor-cache.js's)
      const src = fs.readFileSync(path.join(WEB, n), 'utf8');
      for (const d of src.matchAll(/\bimport\(\s*['"]\.\/([\w.-]+\.m?js)['"]|\bloadModule\(\s*['"]([\w.-]+\.m?js)['"]|new URL\(\s*['"]\.\/([\w.-]+\.m?js)['"]\s*,\s*import\.meta\.url/g)) {
        const f = d[1] || d[2] || d[3];
        ok(fs.existsSync(path.join(WEB, f)), `web/${n} loads ${f}, which is not in web/`);
      }
    }
  } finally {
    child.kill();
    await new Promise((r) => setTimeout(r, 300));
    try { fs.rmSync(data, { recursive: true, force: true }); } catch {}
  }
})().catch((e) => { fail++; console.log(`FAIL ${e.stack || e}`); }).finally(() => {
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
});
