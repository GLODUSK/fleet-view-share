// Sync crypto: what goes up to the fleet-sync bucket is encrypted here first, so Supabase only ever holds ciphertext.
// Shared by the uploader (sync-up.js) and the materializer (sync-down.js); the format below is the contract between
// them and every machine, so a change to it needs a new magic ('FVS2') and code that still reads 'FVS1'.
//
// The key: 32 random bytes, made by the first machine that signs in and kept in Blackbox itself, in
// fleet_sync.settings, key 'sync-key', value_enc = JSON { v: 1, key: <base64> }. Only the signed-in member reads it
// (RLS), and on Henry's machines only henry.yamin@glodusk.com can sign in, so the Google sign-in is the only step: no
// passphrase. Every other machine fetches it once (sync-run.js, on the sign-in) and keeps it with sync-api.js
// protectedStore(<dataDir>/sync, 'sync-key'): DPAPI / Keychain / 0600.
//
// A sealed blob:  'FVS1' (4 bytes) | iv (12 random bytes) | AES-256-GCM ciphertext | tag (16 bytes)
//   AAD = the given label (UTF-8). Objects use their bucket path (rel, without the '<user id>/' prefix), titles use
//   'title:<conversation id>', settings 'setting:<key>', so a blob moved to another place does not open.
// Chunks are gzipped before sealing: sealChunk / openChunk.
//
//   seal(buf|string, key, label) -> Buffer    open(blob, key, label) -> Buffer (throws SyncError code 'bad_blob')
//   sealChunk(buf, key, label) / openChunk(blob, key, label)   the same with gzip inside
//   sealText(string, key, label) -> base64 / openText(base64, key, label) -> string   (titles, settings)
//   loadKey(dir) -> Promise<Buffer|null>   saveKey(dir, key)   forgetKey(dir)   the key on this machine
//   hasKey(dir) -> boolean   whether one is stored (a file check, nothing decrypted)
//   fetchKey(api, dir) -> { key, created, fetched, replaced? }   Blackbox's key (saved here; one here that differs from it is
//     replaced), else the one here when Blackbox has none or does not answer, else a new one made here and put in
//     Blackbox (created). Two machines at once: the first row wins and both keep that one
//   sha256(buf) -> hex
//
// CLI:  node sync-crypto.js key   (fetches it from Blackbox now; sync does this by itself once signed in)
//       node sync-crypto.js status | forget
'use strict';
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const P = require(path.join(__dirname, 'platform.js'));
const S = require(path.join(__dirname, 'sync-api.js'));

const MAGIC = Buffer.from('FVS1', 'ascii');
const IV_LEN = 12, TAG_LEN = 16;
const KEY_SETTING = 'sync-key';
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
const keyStore = (dir) => S.protectedStore(dir, KEY_STORE);
async function loadKey(dir) {
  const t = await keyStore(dir).read();
  if (!t) return null;
  const k = Buffer.from(t.trim(), 'base64');
  return k.length === 32 ? k : null;
}
const saveKey = (dir, key) => keyStore(dir).write(asKey(key).toString('base64'));
const forgetKey = (dir) => keyStore(dir).clear();
// is a key stored here? A file check only (nothing is decrypted), cheap enough for the page to ask every few seconds
const hasKey = (dir) => keyStore(dir).stamp() !== null;

// Blackbox's copy: fleet_sync.settings 'sync-key' (null when no machine has made one yet)
async function readSharedKey(api) {
  const rows = await api.rest('GET', 'settings', { query: { select: 'value_enc', key: `eq.${KEY_SETTING}` } });
  if (!Array.isArray(rows) || !rows.length) return null;
  let j = null;
  try { j = JSON.parse(rows[0].value_enc); } catch {}
  const k = j && j.v === 1 && typeof j.key === 'string' ? Buffer.from(j.key, 'base64') : null;
  if (!k || k.length !== 32) throw new S.SyncError('the sync-key setting is damaged', 0, 'bad_blob');
  return k;
}
async function fetchKey(api, dir) {
  const have = await loadKey(dir);
  if (have) {
    // Blackbox's key is the one every machine seals with: a different one here (kept from before Blackbox's was made
    // again) is swapped for it, or nothing the other machines wrote would open. Blackbox not answering keeps this one
    let shared = null;
    try { shared = await readSharedKey(api); } catch { return { key: have, created: false, fetched: false }; }
    if (!shared || shared.equals(have)) return { key: have, created: false, fetched: false };
    await saveKey(dir, shared);
    return { key: shared, created: false, fetched: true, replaced: true };
  }
  let key = await readSharedKey(api), created = false;
  if (!key) {
    // ignore-duplicates: two machines making it at once, the first one wins and both keep what Blackbox has
    const mine = crypto.randomBytes(32);
    await api.rest('POST', 'settings', { body: { key: KEY_SETTING, value_enc: JSON.stringify({ v: 1, key: mine.toString('base64') }) }, prefer: 'resolution=ignore-duplicates,return=minimal' });
    key = await readSharedKey(api);
    if (!key) throw new S.SyncError('Blackbox did not keep the sync key', 0, 'bad_key');
    created = key.equals(mine);
  }
  await saveKey(dir, key);
  return { key, created, fetched: true };
}

// ---------- CLI ----------
async function cli(argv, io = {}) {
  const out = io.out || ((t) => console.log(t)), err = io.err || ((t) => console.error(t));
  const dataDir = io.dataDir || P.dataDir();
  const dir = S.syncDir(dataDir);
  const [cmd] = argv;
  if (cmd === 'status') {
    out((await loadKey(dir)) ? 'The sync key is on this machine.' : 'No sync key on this machine: sync fetches it from Blackbox once you sign in (or run node sync-crypto.js key).');
    return 0;
  }
  if (cmd === 'forget') { await forgetKey(dir); out('The sync key is removed from this machine.'); return 0; }
  if (cmd === 'key') {
    const api = S.createSync({ dataDir, fetch: io.fetch, store: io.store });
    const st = await api.status();
    if (!st.configured || !st.signedIn) { err('Set up sync and sign in first (node sync-api.js setup / signin).'); return 2; }
    try {
      const r = await fetchKey(api, dir);
      out(!r.fetched ? 'The sync key is on this machine already.' : r.created ? 'A new sync key was made and put in Blackbox; it is saved on this machine.' : 'The sync key came from Blackbox; it is saved on this machine.');
      return 0;
    } catch (e) { err(e.message); return 2; }
  }
  err('usage: node sync-crypto.js key | status | forget');
  return 2;
}

module.exports = {
  seal, open, sealChunk, openChunk, sealText, openText, sha256,
  readSharedKey, fetchKey, loadKey, saveKey, forgetKey, hasKey, cli,
  MAGIC, KEY_SETTING, KEY_STORE,
};

if (require.main === module) {
  cli(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => { console.error(e && e.message ? e.message : String(e)); process.exitCode = 1; });
}
