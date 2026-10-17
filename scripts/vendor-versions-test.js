// The page's bundled libraries are the ones on record: a test, run with the system node:   node scripts/vendor-versions-test.js
// web/vendor/ holds the libraries the page loads from its own server (marked, DOMPurify, highlight.js, xterm.js, the QR
// code maker), and they go out to the public share repo with the rest. web/vendor/VERSIONS.json records each one's
// version, where its files came from and every file's SHA-384. This fails when a file in web/vendor/ is not on record,
// a file on record is gone, a file no longer matches its hash (changed by hand, or a new version put in without
// writing it down), or a file's own banner names another version than the record. Hashes are of the file with CRLF
// turned into LF, so a Windows checkout (core.autocrlf) and a Mac one give the same.
//   --print   print the hash of every file in web/vendor/ (for writing a new version's record), check nothing
// Exit 0 = every file matches its record.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIR = path.resolve(__dirname, '..', 'web', 'vendor');
const RECORD = 'VERSIONS.json';

let failures = 0;
const ok = (cond, what) => { if (!cond) { failures++; console.log(`FAIL ${what}`); } };

// every file under web/vendor/, as a path from it with / between folders
function walk(dir, pre = '') {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = pre + e.name;
    if (e.isDirectory()) out.push(...walk(path.join(dir, e.name), rel + '/'));
    else if (e.isFile()) out.push(rel);
  }
  return out;
}
// the text as git keeps it (LF), whatever the checkout wrote
const lf = (buf) => Buffer.from(buf.toString('latin1').replace(/\r\n/g, '\n'), 'latin1');
const sha384 = (buf) => crypto.createHash('sha384').update(lf(buf)).digest('base64');

const files = walk(DIR).filter((f) => f !== RECORD).sort();

if (process.argv.includes('--print')) {
  for (const f of files) console.log(`${f}  ${sha384(fs.readFileSync(path.join(DIR, f)))}`);
  process.exit(0);
}

let record;
try { record = JSON.parse(fs.readFileSync(path.join(DIR, RECORD), 'utf8')); } catch (e) { console.log(`FAIL web/vendor/${RECORD} does not read: ${e.message}`); process.exit(1); }
ok(Array.isArray(record.libraries) && record.libraries.length > 0, `${RECORD} lists the libraries`);

const owner = new Map(); // file -> the library it is recorded under
for (const lib of record.libraries || []) {
  const name = lib && lib.name;
  ok(typeof name === 'string' && name, 'every library has a name');
  ok(/^\d+\.\d+\.\d+$/.test(String(lib.version || '')), `${name}: a version (x.y.z), not "${lib.version}"`);
  ok(/^https:\/\//.test(String(lib.source || '')), `${name}: the source it came from (an https URL)`);
  ok(typeof lib.license === 'string' && lib.license, `${name}: its license`);
  ok(lib.files && typeof lib.files === 'object' && Object.keys(lib.files).length > 0, `${name}: its files`);
  for (const [f, rec] of Object.entries(lib.files || {})) {
    ok(!owner.has(f), `${f} is recorded once (also under ${owner.get(f)})`);
    owner.set(f, name);
    ok(rec && /^[A-Za-z0-9+/]{64}$/.test(String(rec.sha384 || '')), `${f}: a SHA-384 (base64)`);
    ok(rec && (typeof rec.from === 'string' || (rec.from === null && typeof rec.note === 'string')),
      `${f}: the package file it came from (or, for a file written here, a note saying so)`);
    let buf;
    try { buf = fs.readFileSync(path.join(DIR, f)); } catch { ok(false, `${f} is on record but not in web/vendor/`); continue; }
    ok(rec && sha384(buf) === rec.sha384, `${f} matches its recorded hash (${name} ${lib.version}): it changed, or a new version went in without a new record`);
    // a banner that names a version (marked v18.1.0, DOMPurify 3.4.16, Highlight.js v11.11.1) names this one
    if (/\.(?:m?js|css)$/.test(f)) {
      const head = buf.toString('utf8', 0, 400);
      const m = /(?:\bv|\s)(\d+\.\d+\.\d+)\b/.exec(head);
      if (m) ok(m[1] === lib.version, `${f}: its banner says ${m[1]}, the record ${lib.version}`);
    }
  }
}
for (const f of files) ok(owner.has(f), `web/vendor/${f} is on record in ${RECORD} (version, source, hash)`);

console.log(failures ? `${failures} failed` : `ok: ${files.length} files of ${(record.libraries || []).length} libraries match ${RECORD}`);
process.exit(failures ? 1 : 0);
