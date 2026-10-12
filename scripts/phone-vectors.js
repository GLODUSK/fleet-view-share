// Phone relay test vectors: writes docs/phone-vectors.json, run with the system node:   node scripts/phone-vectors.js
// Fixed inputs and the exact outputs of the relay protocol's crypto (docs/phone.md), made with node's own crypto, so
// relay.js and the phone app can each check theirs against the same numbers: the HKDF direction keys, the AAD, an
// up and a down envelope with z=0 (exact ciphertext), one with z=1 (node's raw DEFLATE: a reader must open it to the
// exact plaintext; another DEFLATE may compress differently, so for its own z=1 only a round trip is checked), two
// envelopes a reader must refuse, a pairing link (v 2), and the pairing's handshake (protocol v2): fixed X25519 private
// keys for the phone and the PC, their public keys, the shared secret, K' = HKDF-SHA256(K || shared, no salt,
// "fleet-view relay v2 paired", 32), its direction keys, the hello and its answer as they go under K, and an envelope
// under K'. --check compares the file with a fresh run (exit 1 if it differs).
// The vectors' `at` times are fixed and old on purpose: they test the crypto, not the 5-minute replay window.
'use strict';
const crypto = require('crypto');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const LABEL = 'fleet-view relay v1';
const PAIRED_INFO = 'fleet-view relay v2 paired';
const OUT = path.join(__dirname, '..', 'docs', 'phone-vectors.json');

const bytes = (from, n) => Buffer.from(Array.from({ length: n }, (_, i) => (from + i) & 0xff));
const b64u = (b) => Buffer.from(b).toString('base64url');
const dirKey = (k, dir) => Buffer.from(crypto.hkdfSync('sha256', k, Buffer.from(LABEL, 'utf8'), Buffer.from(dir, 'utf8'), 32));
const aadText = (topic, d, dir, z) => `${LABEL}|${topic}|${d}|${dir}|${z}`;

// X25519 from raw private bytes (PKCS#8 with a fixed prefix): its raw public key, and the shared secret with a raw public key
const X_PRIV = Buffer.from('302e020100300506032b656e04220420', 'hex'), X_PUB = Buffer.from('302a300506032b656e032100', 'hex');
const xPriv = (raw) => crypto.createPrivateKey({ key: Buffer.concat([X_PRIV, raw]), format: 'der', type: 'pkcs8' });
const xPubOf = (raw) => crypto.createPublicKey(xPriv(raw)).export({ format: 'der', type: 'spki' }).subarray(X_PUB.length);
const xShared = (raw, pub) => crypto.diffieHellman({ privateKey: xPriv(raw), publicKey: crypto.createPublicKey({ key: Buffer.concat([X_PUB, pub]), format: 'der', type: 'spki' }) });

function seal(k, topic, d, dir, nonce, msg, z) {
  let plain = Buffer.from(JSON.stringify(msg), 'utf8');
  if (z) plain = zlib.deflateRawSync(plain);
  const c = crypto.createCipheriv('aes-256-gcm', dirKey(k, dir), nonce);
  c.setAAD(Buffer.from(aadText(topic, d, dir, z), 'utf8'));
  const ct = Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
  return { v: 1, d, dir, n: b64u(nonce), z, c: b64u(ct) };
}

function build() {
  const K = bytes(0x00, 32);
  const uid = '00000000-0000-4000-8000-000000000001';
  const dev = b64u(bytes(0xa0, 12));
  const topic = `fleet:${uid}:${dev}`;
  const at = 1760140800000;

  const upMsg = { t: 'req', id: 'r1', at, m: 'GET', p: '/state', etag: '"abc"' };
  const downMsg = { t: 'res', id: 'r1', at: at + 120, s: 200, b: { ok: true, name: 'Café ☕ 🚀', path: 'Z:\\Github\\fleet-view' } };
  // over 1024 bytes, so a sender would compress it
  const bigMsg = { t: 'res', id: 'r2', at: at + 250, s: 200, b: { lines: Array.from({ length: 60 }, (_, i) => `line ${i}: the quick brown fox jumps over the lazy dog`) } };

  const up = seal(K, topic, dev, 'up', bytes(0x10, 12), upMsg, 0);
  const down = seal(K, topic, dev, 'down', bytes(0x20, 12), downMsg, 0);
  const big = seal(K, topic, dev, 'down', bytes(0x30, 12), bigMsg, 1);

  // must be refused: an up envelope relabelled as down (the AAD and the key differ), and one with a flipped bit
  const relabelled = { ...up, dir: 'down' };
  const ct = Buffer.from(up.c, 'base64url');
  ct[0] ^= 0x01;
  const flipped = { ...up, c: b64u(ct) };

  const pairing = { v: 2, url: 'https://example-project.supabase.co', key: 'test-publishable-key', uid, email: 'henry@example.com', pcName: 'TEST-PC', dev, k: b64u(K), exp: at + 600000 };

  // the handshake: the phone's hello under K carries its X25519 public key, the PC's answer under K carries its own,
  // and both make K' from K and the shared secret; then the phone's first envelope goes under K'
  const phoneSk = bytes(0x40, 32), pcSk = bytes(0x60, 32);
  const phonePk = xPubOf(phoneSk), pcPk = xPubOf(pcSk);
  const shared = xShared(phoneSk, pcPk);
  if (!shared.equals(xShared(pcSk, phonePk))) throw new Error('X25519: the two sides disagree');
  const K2 = Buffer.from(crypto.hkdfSync('sha256', Buffer.concat([K, shared]), Buffer.alloc(0), Buffer.from(PAIRED_INFO, 'utf8'), 32));
  const helloMsg = { t: 'hello', id: 'h1', at: at + 400, app: '1.0.0', device: 'Test iPhone', epk: b64u(phonePk) };
  const welcomeMsg = { t: 'res', id: 'h1', at: at + 520, s: 200, b: { paired: true, pcName: 'TEST-PC', version: '1.0.99', epk: b64u(pcPk) } };
  const firstMsg = { t: 'req', id: 'r3', at: at + 640, t0: at + 640, m: 'GET', p: '/state' };

  return {
    about: 'Test vectors for the phone relay protocol (docs/phone.md), made by node scripts/phone-vectors.js. Do not edit by hand.',
    label: LABEL,
    K: b64u(K),
    uid, dev, topic,
    keys: { up: dirKey(K, 'up').toString('hex'), down: dirKey(K, 'down').toString('hex') },
    aad: { up0: aadText(topic, dev, 'up', 0), down0: aadText(topic, dev, 'down', 0), down1: aadText(topic, dev, 'down', 1) },
    open: [
      { name: 'up request, z=0 (exact)', envelope: up, plaintext: JSON.stringify(upMsg) },
      { name: 'down answer with UTF-8, z=0 (exact)', envelope: down, plaintext: JSON.stringify(downMsg) },
      { name: 'down answer, z=1 (node raw DEFLATE; open it to this exact plaintext)', envelope: big, plaintext: JSON.stringify(bigMsg) },
    ],
    refuse: [
      { name: 'up envelope relabelled as down', envelope: relabelled },
      { name: 'one bit of the ciphertext flipped', envelope: flipped },
    ],
    pairing: { json: pairing, link: `fleetview://pair?d=${b64u(Buffer.from(JSON.stringify(pairing), 'utf8'))}` },
    paired: {
      info: PAIRED_INFO,
      phone: { sk: phoneSk.toString('hex'), pk: b64u(phonePk) },
      pc: { sk: pcSk.toString('hex'), pk: b64u(pcPk) },
      shared: shared.toString('hex'),
      K: b64u(K2),
      keys: { up: dirKey(K2, 'up').toString('hex'), down: dirKey(K2, 'down').toString('hex') },
      open: [
        { name: "the hello under K, with the phone's epk (exact)", key: 'K', envelope: seal(K, topic, dev, 'up', bytes(0x50, 12), helloMsg, 0), plaintext: JSON.stringify(helloMsg) },
        { name: "its answer under K, with the PC's epk (exact)", key: 'K', envelope: seal(K, topic, dev, 'down', bytes(0x58, 12), welcomeMsg, 0), plaintext: JSON.stringify(welcomeMsg) },
        { name: "the first request under K' (exact)", key: 'paired', envelope: seal(K2, topic, dev, 'up', bytes(0x70, 12), firstMsg, 0), plaintext: JSON.stringify(firstMsg) },
      ],
    },
  };
}

const text = `${JSON.stringify(build(), null, 2)}\n`;
if (process.argv.includes('--check')) {
  let old = '';
  try { old = fs.readFileSync(OUT, 'utf8'); } catch {}
  // a checkout with core.autocrlf has CRLF line ends
  // the z=1 envelope's ciphertext is node's raw DEFLATE, which another zlib (another node, or a Mac's) may make
  // differently: it is left out of the compare (relay-test.js opens the stored one to its exact plaintext)
  const same = (t) => { try { return JSON.stringify(JSON.parse(t), (k, v) => (v && typeof v === 'object' && v.z === 1 && typeof v.c === 'string' ? { ...v, c: '(z=1)' } : v)); } catch { return t; } };
  if (same(old.replace(/\r\n/g, '\n')) !== same(text)) { console.error('docs/phone-vectors.json differs from a fresh run: node scripts/phone-vectors.js'); process.exitCode = 1; }
  else console.log('docs/phone-vectors.json is current');
} else {
  fs.writeFileSync(OUT, text);
  console.log(`wrote ${path.relative(process.cwd(), OUT) || OUT}`);
}
