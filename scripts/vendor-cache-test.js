// vendor-cache.js: a test, run with the system node:   node scripts/vendor-cache-test.js   (--net: also the real set from the CDN)
// Its route on a spare port, a temp folder for the cache and a fake downloader: a set's files are downloaded, checked
// and kept, then served from disk (no second download), HEAD too; a copy changed on disk is downloaded again; a file
// that does not match its pinned hash is refused (502, a server.log line, nothing kept) and so is a failed download;
// requests for the same file at once share one download; unknown sets, files and paths are 404. Then the real pinned
// set: the one web/voice-worker.js asks for, with SHA-384 hashes. Exit 0 = all pass.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const { createVendorCache, SETS, sha384 } = require(path.join(ROOT, 'vendor-cache.js'));
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'vendor-cache-test-'));

let failures = 0, passes = 0;
const ok = (cond, what) => { if (cond) passes++; else { failures++; console.log(`FAIL ${what}`); } };
const eq = (a, b, what) => ok(JSON.stringify(a) === JSON.stringify(b), `${what}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const A = Buffer.from('export const a = 1;\n'), B = Buffer.alloc(300000, 7), C = Buffer.from('export const c = 3;\n');
const sets = {
  'lib-1': { base: 'https://cdn.example/lib@1/', files: { 'a.js': sha384(A), 'b.wasm': sha384(B) } },
  'lib-2': { base: 'https://cdn.example/lib@2/', files: { 'c.mjs': sha384(Buffer.from('what was pinned')) } },
  'lib-3': { base: 'https://cdn.example/lib@3/', files: { 'd.js': sha384(A) } },
};
const remote = { 'https://cdn.example/lib@1/a.js': A, 'https://cdn.example/lib@1/b.wasm': B, 'https://cdn.example/lib@2/c.mjs': C };
const gets = [];
async function get(url) {
  gets.push(url);
  await sleep(30);
  if (!remote[url]) throw new Error('getaddrinfo ENOTFOUND cdn.example');
  return remote[url];
}
const logs = [];
const make = (dir) => createVendorCache({ dir, log: (k, t) => logs.push(t), sets, get });

function serve(cache) {
  const srv = http.createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (!cache.route(req, res, pathname)) { res.writeHead(418); res.end(); }
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
}
function req(srv, p, method = 'GET') {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: srv.address().port, path: p, method }, (res) => {
      const parts = [];
      res.on('data', (b) => parts.push(b));
      res.on('end', () => {
        const body = Buffer.concat(parts);
        let json = null;
        try { json = JSON.parse(body.toString()); } catch {}
        resolve({ code: res.statusCode, headers: res.headers, body, json });
      });
    });
    r.on('error', reject);
    r.end();
  });
}

(async () => {
  const dir = path.join(T, 'vendor');
  const cache = make(dir);
  const srv = await serve(cache);
  try {
    // the whole set: both downloaded, checked and kept
    let r = await req(srv, '/vendor-cache/lib-1/');
    eq([r.code, r.json], [200, { ok: true }], 'the set answers ok');
    eq(gets.slice().sort(), ['https://cdn.example/lib@1/a.js', 'https://cdn.example/lib@1/b.wasm'], 'each file downloaded once');
    ok(fs.readFileSync(path.join(dir, 'lib-1', 'a.js')).equals(A) && fs.readFileSync(path.join(dir, 'lib-1', 'b.wasm')).equals(B), 'both kept on disk');
    ok(logs.some((l) => /downloaded lib-1\/b\.wasm \(300000 bytes\) and checked it/.test(l)), 'a log line for the download');

    // served from disk, with its type and kept by the browser for good
    gets.length = 0;
    r = await req(srv, '/vendor-cache/lib-1/a.js');
    ok(r.code === 200 && r.body.equals(A), 'a.js served');
    eq([r.headers['content-type'], r.headers['cache-control'], r.headers['x-content-type-options']], ['text/javascript; charset=utf-8', 'public, max-age=31536000, immutable', 'nosniff'], 'a.js headers');
    r = await req(srv, '/vendor-cache/lib-1/b.wasm', 'HEAD');
    eq([r.code, r.headers['content-type'], r.headers['content-length'], r.body.length], [200, 'application/wasm', '300000', 0], 'HEAD b.wasm');
    eq(gets, [], 'nothing downloaded again');

    // a copy changed on disk: downloaded again, the right one served
    fs.writeFileSync(path.join(dir, 'lib-1', 'a.js'), 'alert(1); // not what was pinned\n');
    r = await req(srv, '/vendor-cache/lib-1/a.js');
    ok(r.code === 200 && r.body.equals(A), 'a changed copy is replaced and the pinned one served');
    eq(gets, ['https://cdn.example/lib@1/a.js'], 'the changed one downloaded again');
    ok(logs.some((l) => /copy of lib-1\/a\.js on disk does not match/.test(l)), 'a log line for the changed copy');

    // another run (nothing in memory): checks the copies on disk, downloads nothing
    gets.length = 0;
    const srv2 = await serve(make(dir));
    r = await req(srv2, '/vendor-cache/lib-1/');
    eq([r.code, gets], [200, []], 'a new run uses the checked copies');
    srv2.close();

    // a file that does not match its pinned hash: refused, not kept, said in the log and in the answer
    r = await req(srv, '/vendor-cache/lib-2/c.mjs');
    eq(r.code, 502, 'a wrong hash is a 502');
    ok(/does not match its pinned hash: refused/.test((r.json && r.json.message) || ''), `the answer says why: ${r.body}`);
    ok(!fs.existsSync(path.join(dir, 'lib-2', 'c.mjs')), 'the wrong file is not kept');
    ok(!fs.readdirSync(path.join(dir)).includes('lib-2') || !fs.readdirSync(path.join(dir, 'lib-2')).length, 'no temp file left');
    ok(logs.some((l) => /https:\/\/cdn\.example\/lib@2\/c\.mjs does not match its pinned hash \(sha384-.+, want sha384-.+\): refused/.test(l)), 'a log line for the wrong hash');
    r = await req(srv, '/vendor-cache/lib-2/');
    ok(r.code === 502 && /the speech library: c\.mjs from the CDN does not match/.test(r.json && r.json.message), 'the set says so too');

    // a failed download
    r = await req(srv, '/vendor-cache/lib-3/');
    ok(r.code === 502 && /could not download d\.js \(getaddrinfo ENOTFOUND/.test(r.json && r.json.message), `a failed download says so: ${r.body}`);

    // at once: one download for all of them
    gets.length = 0;
    const dir2 = path.join(T, 'vendor2');
    const srv3 = await serve(make(dir2));
    const all = await Promise.all([1, 2, 3].map(() => req(srv3, '/vendor-cache/lib-1/b.wasm')));
    ok(all.every((x) => x.code === 200 && x.body.equals(B)), 'three at once all get it');
    eq(gets, ['https://cdn.example/lib@1/b.wasm'], 'three at once share one download');
    srv3.close();

    // what is not there
    for (const p of ['/vendor-cache/nope/', '/vendor-cache/nope/a.js', '/vendor-cache/lib-1/x.js', '/vendor-cache/lib-1/a.txt', '/vendor-cache/lib-1/../a.js', '/vendor-cache/lib-1/sub/a.js', '/vendor-cache/__proto__/', '/vendor-cache/lib-1/constructor']) {
      r = await req(srv, p);
      eq(r.code, 404, `${p} is 404`);
    }
    ok(!cache.route({}, {}, '/vendor-cachex/lib-1/'), 'other paths are not its own');
  } finally { srv.close(); }

  // the real set: the one the worker asks for, every file with a SHA-384 and a pinned URL
  const worker = fs.readFileSync(path.join(ROOT, 'web', 'voice-worker.js'), 'utf8');
  const m = /\/vendor-cache\/([\w.@-]+)\//.exec(worker);
  ok(!!m && !!SETS[m[1]], `voice-worker.js asks for a set vendor-cache.js has (${m && m[1]})`);
  for (const [name, set] of Object.entries(SETS)) {
    ok(/^https:\/\/cdn\.jsdelivr\.net\/npm\/[^/]+(\/[^/]+)?@\d+\.\d+\.\d+\/dist\/$/.test(set.base), `${name}: its base names an exact version`);
    for (const [f, h] of Object.entries(set.files)) ok(/^[A-Za-z0-9+/]{64}$/.test(h), `${name}/${f}: a SHA-384`);
  }
  if (m && SETS[m[1]]) {
    ok(/import\(LIB_DIR \+ 'transformers\.min\.js'\)/.test(worker) && !!SETS[m[1]].files['transformers.min.js'], 'the worker imports a file of the set');
    ok(!/https?:\/\/(cdn\.jsdelivr\.net|unpkg\.com)/.test(worker.replace(/^\s*\/\/.*$/gm, '')), 'the worker loads no code from a CDN');
  }

  // --net: the real files from the CDN match their pins
  if (process.argv.includes('--net')) {
    const real = createVendorCache({ dir: path.join(T, 'real'), log: (k, t) => console.log(t) });
    for (const [name, set] of Object.entries(SETS)) {
      for (const f of Object.keys(set.files)) {
        try { await real.ensure(name, f); passes++; } catch (e) { failures++; console.log(`FAIL ${name}/${f} from the CDN: ${e.message}`); }
      }
    }
  }

  fs.rmSync(T, { recursive: true, force: true });
  console.log(`${failures ? 'FAIL' : 'ok'}: ${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.log(`FAIL ${e.stack || e}`); process.exit(1); });
