// The chat box's speech library, served from this PC after one checked download.
// The mic (web/voice.js) runs Whisper in a worker (web/voice-worker.js) with transformers.js and the onnxruntime-web
// files it loads: about 22 MB, so they are not in git (nor in the public share repo). The first time voice is used,
// the server downloads each file of the pinned set from its pinned CDN URL, checks it against the SHA-384 written
// here, keeps it under <data dir>/vendor/<set>/ and serves it from the page's own origin. A file that does not match
// is thrown away and never served: then there is no voice (the page says why, and server.log), never unchecked code.
// The hashes are of the files in the npm tarball of @huggingface/transformers 3.8.1 (the tarball checked against the
// registry's integrity), which jsDelivr's copies match byte for byte. A new version is a new set here (its URLs and
// hashes) and its name in web/voice-worker.js. The model weights the library then fetches from huggingface.co are
// data, not code, and keep coming from there.
//   createVendorCache({ dir, log, sets?, get? }) -> { route(req, res, pathname) -> bool, ensure(set, file) -> Promise<path> }
//     dir: where the sets go; log(key, text): a server.log line (keyed, so a repeat can be held back);
//     sets / get(url) -> Promise<Buffer>: other sets and another downloader, for the tests
//   GET /vendor-cache/<set>/         { ok: true } once every file of the set is here and checked, else 502 { ok: false, message }
//   GET /vendor-cache/<set>/<file>   the file (downloaded and checked first if need be); the browser keeps it for good,
//                                    since a set's files never change
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const SETS = {
  'transformers-3.8.1': {
    base: 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/',
    files: {
      'transformers.min.js': 'sOua6i337lNLWtuIG44PBf5JXIvhoicFClCcI4XHDe/eHW3dwhQ3Y6t6wQjfRrkT',
      'ort-wasm-simd-threaded.jsep.mjs': '7GJqH5vc83Yt7VHwrMXTM8bNCrt/e/8eCtok8zlB2u5dwqmhzSakzCkQWrfYGRN4',
      'ort-wasm-simd-threaded.jsep.wasm': 'u/bDsx39c+wt0LbHmOCydxt4fyiig3118hQgOTfOvrfkgScM4hRo2IwTtlxyoI02',
    },
  },
};
const TYPES = { '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.wasm': 'application/wasm' };
const MAX_BYTES = 64 << 20; // the wasm is 21 MB
const sha384 = (buf) => crypto.createHash('sha384').update(buf).digest('base64');

// a whole https response body; redirects followed (a few), anything but 200 or a body past MAX_BYTES refused
function httpsGet(url, hops = 3) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'fleet-view' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && hops > 0) {
        res.resume();
        return resolve(httpsGet(new URL(res.headers.location, url).href, hops - 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      const parts = [];
      let n = 0;
      res.on('data', (b) => {
        n += b.length;
        if (n > MAX_BYTES) { req.destroy(new Error('too big')); return; }
        parts.push(b);
      });
      res.on('end', () => resolve(Buffer.concat(parts)));
      res.on('error', reject);
    });
    req.setTimeout(60e3, () => req.destroy(new Error('no answer for a minute')));
    req.on('error', reject);
  });
}

function createVendorCache({ dir, log = () => {}, sets = SETS, get = httpsGet }) {
  const checked = new Map(); // "<set>/<file>" -> "<size>:<mtime>" of the copy on disk that matched its hash
  const pending = new Map(); // "<set>/<file>" -> the download (or check) under way, shared by every request for it

  // the file's path once a copy that matches its pinned hash is there: the one on disk, else a fresh download
  function ensure(set, file) {
    const s = Object.prototype.hasOwnProperty.call(sets, set) ? sets[set] : null;
    const want = s && Object.prototype.hasOwnProperty.call(s.files, file) ? s.files[file] : null;
    if (!want) return Promise.reject(Object.assign(new Error(`no ${set}/${file} here`), { code: 404 }));
    const key = `${set}/${file}`, at = path.join(dir, set, file);
    const stamp = (st) => `${st.size}:${st.mtimeMs}`;
    try { if (checked.get(key) === stamp(fs.statSync(at))) return Promise.resolve(at); } catch {}
    if (pending.has(key)) return pending.get(key);
    const job = (async () => {
      // a copy from an earlier run: read and checked once per run (and again if it changes)
      try {
        const buf = await fs.promises.readFile(at);
        if (sha384(buf) === want) { checked.set(key, stamp(fs.statSync(at))); return at; }
        log(`vendor-bad:${key}`, `vendor-cache: the copy of ${key} on disk does not match its pinned hash: downloading it again`);
        fs.rmSync(at, { force: true });
      } catch {}
      const url = s.base + file;
      let buf;
      try { buf = await get(url); } catch (e) {
        log(`vendor-get:${key}`, `vendor-cache: could not download ${url}: ${e.message || e}`);
        throw new Error(`could not download ${file} (${e.message || e})`);
      }
      const got = sha384(buf);
      if (got !== want) {
        log(`vendor-hash:${key}`, `vendor-cache: ${url} does not match its pinned hash (sha384-${got}, want sha384-${want}): refused, not kept`);
        throw new Error(`${file} from the CDN does not match its pinned hash: refused`);
      }
      fs.mkdirSync(path.dirname(at), { recursive: true });
      const tmp = `${at}.${process.pid}.tmp`;
      await fs.promises.writeFile(tmp, buf);
      fs.renameSync(tmp, at);
      checked.set(key, stamp(fs.statSync(at)));
      log(`vendor-ok:${key}`, `vendor-cache: downloaded ${key} (${buf.length} bytes) and checked it`);
      return at;
    })();
    pending.set(key, job);
    job.then(() => pending.delete(key), () => pending.delete(key));
    return job;
  }

  const json = (res, code, body) => {
    const buf = Buffer.from(JSON.stringify(body));
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': buf.length, 'Cache-Control': 'no-store' });
    res.end(buf);
  };

  function route(req, res, pathname) {
    if (!pathname.startsWith('/vendor-cache/')) return false;
    const m = /^\/vendor-cache\/([\w.@-]+)\/([\w.@-]*)$/.exec(pathname);
    const set = m && Object.prototype.hasOwnProperty.call(sets, m[1]) ? sets[m[1]] : null;
    if (!set) { json(res, 404, { ok: false, message: 'not found' }); return true; }
    if (!m[2]) {
      // the whole set, one file after another (the page asks this before it loads any of them)
      (async () => { for (const f of Object.keys(set.files)) await ensure(m[1], f); })()
        .then(() => json(res, 200, { ok: true }), (e) => json(res, 502, { ok: false, message: `the speech library: ${e.message || e}` }));
      return true;
    }
    const type = TYPES[path.extname(m[2]).toLowerCase()];
    if (!type || !Object.prototype.hasOwnProperty.call(set.files, m[2])) { json(res, 404, { ok: false, message: 'not found' }); return true; }
    ensure(m[1], m[2]).then((at) => {
      const size = fs.statSync(at).size;
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': size, 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(at).on('error', () => res.destroy()).pipe(res);
    }, (e) => json(res, e.code === 404 ? 404 : 502, { ok: false, message: `the speech library: ${e.message || e}` }));
    return true;
  }

  return { route, ensure };
}

module.exports = { createVendorCache, SETS, sha384 };
