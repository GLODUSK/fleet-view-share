// Sync crypto: what goes up to the fleet-sync bucket is encrypted here first, so Supabase only ever holds ciphertext.
// Shared by the uploader (sync-up.js) and the materializer (sync-down.js); the format below is the contract between
// them and every machine, so a change to it needs a new magic ('FVS2') and code that still reads 'FVS1'.
//
// The key: 32 bytes, from a passphrase Henry sets once and types once on each machine:
//   scrypt(passphrase NFC, salt 16 bytes, N 2^17, r 8, p 1) -> 32 bytes
// The salt and a check value live in fleet_sync.settings, key 'kdf', value_enc = JSON
//   { v: 1, salt: <base64>, N, r, p, check: <base64 of seal('fleet-view-sync-check', key, 'kdf-check')> }
// so a second machine can tell a wrong passphrase from a right one. The derived key (never the passphrase) is kept on
// each machine with sync-api.js protectedStore(<dataDir>/sync, 'sync-key'): DPAPI / Keychain / 0600.
//
// A sealed blob:  'FVS1' (4 bytes) | iv (12 random bytes) | AES-256-GCM ciphertext | tag (16 bytes)
//   AAD = the given label (UTF-8). Objects use their bucket path (rel, without the '<user id>/' prefix), titles use
//   'title:<conversation id>', settings 'setting:<key>', so a blob moved to another place does not open.
// Chunks are gzipped before sealing: sealChunk / openChunk.
//
//   deriveKey(passphrase, kdf) -> Promise<Buffer>   newKdf() -> { v, salt, N, r, p } (no check yet)
//   makeCheck(key) -> base64        checkKey(key, kdf) -> boolean
//   seal(buf|string, key, label) -> Buffer    open(blob, key, label) -> Buffer (throws SyncError code 'bad_blob')
//   sealChunk(buf, key, label) / openChunk(blob, key, label)   the same with gzip inside
//   sealText(string, key, label) -> base64 / openText(base64, key, label) -> string   (titles, settings)
//   loadKey(dir) -> Promise<Buffer|null>   saveKey(dir, key)   forgetKey(dir)   the key on this machine
//   sha256(buf) -> hex
//
// CLI:  node sync-crypto.js passphrase   (asks for it without echo; the first machine sets it, others must match)
//       node sync-crypto.js status | forget
'use strict';
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const P = require(path.join(__dirname, 'platform.js'));
const S = require(path.join(__dirname, 'sync-api.js'));

const MAGIC = Buffer.from('FVS1', 'ascii');
const IV_LEN = 12, TAG_LEN = 16;
const KDF_DEFAULTS = { N: 2 ** 17, r: 8, p: 1 };
const KDF_SETTING = 'kdf';
const CHECK_TEXT = 'fleet-view-sync-check';
const CHECK_LABEL = 'kdf-check';
const KEY_STORE = 'sync-key';
const MAX_CHUNK_PLAIN = 64 * 1024 * 1024; // openChunk refuses to inflate past this (a gzip bomb)

const bad = (m) => new S.SyncError(m, 0, 'bad_blob');
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const asKey = (key) => {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new S.SyncError('the sync key must be 32 bytes', 0, 'bad_key');
  return key;
};
const asLabel = (label) => {
  if (typeof label !== 'string' || !label) throw new S.SyncError('seal needs a label', 0, 'bad_request');
  return Buffer.from(label, 'utf8');
};

function seal(data, key, label) {
  const plain = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
  const iv = crypto.randomBytes(IV_LEN);
  const c = crypto.createCipheriv('aes-256-gcm', asKey(key), iv);
  c.setAAD(asLabel(label));
  const body = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([MAGIC, iv, body, c.getAuthTag()]);
}
function open(blob, key, label) {
  if (!Buffer.isBuffer(blob) || blob.length < MAGIC.length + IV_LEN + TAG_LEN) throw bad('not a sealed sync blob (too short)');
  if (!blob.subarray(0, 4).equals(MAGIC)) throw bad('not a sealed sync blob (no FVS1 header)');
  const iv = blob.subarray(4, 4 + IV_LEN), tag = blob.subarray(blob.length - TAG_LEN);
  const d = crypto.createDecipheriv('aes-256-gcm', asKey(key), iv);
  d.setAAD(asLabel(label));
  d.setAuthTag(tag);
  try { return Buffer.concat([d.update(blob.subarray(4 + IV_LEN, blob.length - TAG_LEN)), d.final()]); } catch {
    throw bad('the blob did not open: another key, another place, or damaged');
  }
}
const sealChunk = (buf, key, label) => seal(zlib.gzipSync(buf), key, label);
function openChunk(blob, key, label) {
  try { return zlib.gunzipSync(open(blob, key, label), { maxOutputLength: MAX_CHUNK_PLAIN }); } catch (e) {
    if (e instanceof S.SyncError) throw e;
    throw bad(`the chunk did not inflate (${e.code || e.message})`);
  }
}
const sealText = (text, key, label) => seal(Buffer.from(String(text), 'utf8'), key, label).toString('base64');
const openText = (b64, key, label) => open(Buffer.from(String(b64 || ''), 'base64'), key, label).toString('utf8');

// ---------- the key ----------
const newKdf = () => ({ v: 1, salt: crypto.randomBytes(16).toString('base64'), ...KDF_DEFAULTS });
function deriveKey(passphrase, kdf) {
  if (typeof passphrase !== 'string' || passphrase.length < 8) return Promise.reject(new S.SyncError('the passphrase needs at least 8 characters', 0, 'bad_request'));
  if (!kdf || kdf.v !== 1 || typeof kdf.salt !== 'string') return Promise.reject(new S.SyncError('not a kdf record', 0, 'bad_request'));
  const N = Number(kdf.N), r = Number(kdf.r), p = Number(kdf.p);
  if (!(N >= 2 ** 14 && N <= 2 ** 20 && (N & (N - 1)) === 0 && r >= 8 && r <= 32 && p >= 1 && p <= 4)) return Promise.reject(new S.SyncError('kdf parameters out of range', 0, 'bad_request'));
  return new Promise((resolve, reject) => crypto.scrypt(passphrase.normalize('NFC'), Buffer.from(kdf.salt, 'base64'), 32,
    { N, r, p, maxmem: 256 * N * r + 64 * 1024 * 1024 }, (e, k) => (e ? reject(e) : resolve(k))));
}
const makeCheck = (key) => seal(CHECK_TEXT, key, CHECK_LABEL).toString('base64');
function checkKey(key, kdf) {
  try { return open(Buffer.from(String(kdf && kdf.check), 'base64'), key, CHECK_LABEL).toString('utf8') === CHECK_TEXT; } catch { return false; }
}
const keyStore = (dir) => S.protectedStore(dir, KEY_STORE);
async function loadKey(dir) {
  const t = await keyStore(dir).read();
  if (!t) return null;
  const k = Buffer.from(t.trim(), 'base64');
  return k.length === 32 ? k : null;
}
const saveKey = (dir, key) => keyStore(dir).write(asKey(key).toString('base64'));
const forgetKey = (dir) => keyStore(dir).clear();

// the kdf row in fleet_sync.settings (value_enc holds plain JSON here: a salt and a check are not secret)
async function readKdf(api) {
  const rows = await api.rest('GET', 'settings', { query: { select: 'value_enc', key: `eq.${KDF_SETTING}` } });
  if (!Array.isArray(rows) || !rows.length) return null;
  try { return JSON.parse(rows[0].value_enc); } catch { throw new S.SyncError('the kdf setting is damaged', 0, 'bad_blob'); }
}
// passphrase -> the key, saved on this machine. The first machine writes the kdf row; later ones must match its check
async function setPassphrase(api, dir, passphrase) {
  let kdf = await readKdf(api);
  let created = false;
  if (!kdf) {
    kdf = newKdf();
    const key = await deriveKey(passphrase, kdf);
    kdf.check = makeCheck(key);
    // ignore-duplicates: two machines setting it at once, the first one wins and the second is checked against it
    await api.rest('POST', 'settings', { body: { key: KDF_SETTING, value_enc: JSON.stringify(kdf) }, prefer: 'resolution=ignore-duplicates,return=minimal' });
    kdf = await readKdf(api);
    created = true;
  }
  const key = await deriveKey(passphrase, kdf);
  if (!checkKey(key, kdf)) throw new S.SyncError(created ? 'another machine set a different passphrase at the same moment: use that one' : 'that is not the sync passphrase set on your other machine', 0, 'wrong_passphrase');
  await saveKey(dir, key);
  return { created };
}

// ---------- CLI ----------
function askHidden(prompt) {
  return new Promise((resolve, reject) => {
    const { stdin, stdout } = process;
    if (!stdin.isTTY) { // piped: one line
      let buf = '';
      stdin.setEncoding('utf8');
      stdin.on('data', (d) => { buf += d; });
      stdin.on('end', () => resolve(buf.replace(/\r?\n$/, '')));
      stdin.on('error', reject);
      return;
    }
    stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let s = '';
    const onData = (ch) => {
      for (const c of ch) {
        if (c === '\r' || c === '\n') { stdin.setRawMode(false); stdin.pause(); stdin.off('data', onData); stdout.write('\n'); return resolve(s); }
        if (c === '\u0003') { stdin.setRawMode(false); stdout.write('\n'); return reject(new Error('cancelled')); }
        if (c === '\u007f' || c === '\b') s = s.slice(0, -1); else s += c;
      }
    };
    stdin.on('data', onData);
  });
}
async function cli(argv, io = {}) {
  const out = io.out || ((t) => console.log(t)), err = io.err || ((t) => console.error(t));
  const dataDir = io.dataDir || P.dataDir();
  const dir = S.syncDir(dataDir);
  const [cmd] = argv;
  if (cmd === 'status') {
    out((await loadKey(dir)) ? 'The sync key is on this machine.' : 'No sync key on this machine: run node sync-crypto.js passphrase.');
    return 0;
  }
  if (cmd === 'forget') { await forgetKey(dir); out('The sync key is removed from this machine.'); return 0; }
  if (cmd === 'passphrase') {
    const api = S.createSync({ dataDir, fetch: io.fetch, store: io.store });
    const st = await api.status();
    if (!st.configured || !st.signedIn) { err('Set up sync and sign in first (node sync-api.js setup / signin).'); return 2; }
    const ask = io.ask || askHidden;
    const existing = await readKdf(api);
    const p1 = await ask(existing ? 'The sync passphrase (the one set on your other machine): ' : 'Choose a sync passphrase (8+ characters; every machine needs it): ');
    if (!existing) {
      const p2 = await ask('Again: ');
      if (p1 !== p2) { err('The two did not match.'); return 2; }
    }
    try {
      const r = await setPassphrase(api, dir, p1);
      out(r.created ? 'Sync passphrase set; the key is saved on this machine.' : 'Passphrase matches; the key is saved on this machine.');
      return 0;
    } catch (e) { err(e.message); return 2; }
  }
  err('usage: node sync-crypto.js passphrase | status | forget');
  return 2;
}

module.exports = {
  seal, open, sealChunk, openChunk, sealText, openText, sha256,
  newKdf, deriveKey, makeCheck, checkKey, readKdf, setPassphrase, loadKey, saveKey, forgetKey, cli,
  MAGIC, KDF_SETTING, KEY_STORE,
};

if (require.main === module) {
  cli(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => { console.error(e && e.message ? e.message : String(e)); process.exitCode = 1; });
}
