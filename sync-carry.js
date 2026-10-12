// sync-carry.js: what a move carries besides the conversation (docs/sync-follow.md items 3 and 4; the mover, sync-move.js,
// calls it). The code the chat was changing travels as a work pack (sync-work.js), sealed with the sync key in the
// fleet-sync bucket; the env files and the tools' sign-ins travel only over the link between the machines (link.js:
// keys only a pairing made, never Supabase's tables or storage), straight from the machine that had the chat; then the
// new machine says what it still lacks (the ready check) and leaves Claude a note about the move.
//
//   createCarry({ api, key, dataDir, log, now, home, env, platform, device, link, roots, work, which, run, cap })
//     -> { packOut, putAwayAfter, envFiles, logins, peerAllowed, fetchPack, newestSnapshot, dropPack, unpackIn, undo,
//          relocateLog, secretsIn, ready, installDeps, noteText, saveNote, getNote, dropNote, snapshot }
//   api      sync-api.js createSync()'s object: rest() and storage (upload, download, remove)
//   key      the 32-byte sync key; device() -> this machine's sync device id; link() -> link.js's object or null
//   roots()  -> [folder]: the repos Fleet View lists here (a moved chat's checkout is found among them by its origin)
//   work     sync-work.js (tests may wrap it); home, env (process.env), platform (process.platform): where the tools'
//            files are; which(name) -> a path or null; run(file, args, { input, cwd, env, timeoutMs }) -> Promise of
//            { code, out, err } (tests stub the tools); cap: the most one pack carries (sync-work.js's 200 MB)
//
// ---------- the work pack in storage (docs/sync-format.md "The work pack") ----------
// Every blob of a conversation's packs (sha256-named, sync-work.js) is kept once per conversation, in pieces of at
// most 8 MiB, each gzipped and sealed (sync-crypto.js sealChunk, the label its path):
//   w/<conversation id>/b/<blob sha256>/<n>      a blob's n-th piece
//   w/<conversation id>/p/<pack id>              the pack's record: { v: 1, id, manifest, blobs: { <sha256>: size } }
// and the list of a conversation's packs is the settings row work:<conversation id>, sealed like the mover's rows:
//   { v: 1, id, packs: [{ pack, kind: 'move' | 'snapshot', by (device), at (ISO), record (sha256 of the record's
//     JSON), blobs: { <sha256>: size }, summary, sig? }] }
// pack ids are 16 hex digits. A move's pack goes when the new owner has laid it down (dropPack); snapshots (a
// portable chat's work at the end of a turn, for a pickup while its host is off) are kept 3 to a conversation; a
// blob goes when no pack left names it.
//
// ---------- A, the machine that had the chat ----------
//   packOut({ id, file, canCarry, noWork, list, toName }) -> { work, local }: the folder is the log's last cwd; a
//     portable one (sync-work.js inspect) is packed and uploaded: work { pack, record, kind, branch, summary, notes,
//     shared, env }; else work { none: why }; a pack sync-work.js refuses throws a CarryError 'refused', or with
//     noWork gives work { refused: why }. local (what this machine keeps for the peer routes and the put-away):
//     { cwd, root, kind, envBase, env, pack } | null. canCarry false (the other machine's Fleet View is older): work
//     { none } and nothing is packed or put away.
//   putAwayAfter(local, { id, toName, list }) -> { stashed, why }: sync-work.js putAway, only when no other live chat
//     here (the host's list) works in that checkout or worktree, and never in the checkout this Fleet View runs from;
//     nothing is ever deleted
//   envFiles(local) -> [{ path, b64 }]: the env files the pack named (paths from the checkout's top), each a plain
//     file inside it (no link), at most 1 MB each and 4 MB in all
//   logins(local, account) -> { gh?, vercel?, supabase?, npm?, mcp? }: the sign-ins this machine has for the allowlisted
//     tools (gh's token and user; Vercel's and Supabase's tokens; ~/.npmrc's auth lines for the registries the repo
//     uses; the account's remote (http/sse) MCP servers for the project and the user, and the names of the local ones)
//   peerAllowed(peer) -> whether another call from that machine fits (12 a minute)
//
// ---------- B, the machine taking it over ----------
//   fetchPack(id, ref) -> { manifest, blobs }: every piece downloaded, opened, joined and checked against the record
//   newestSnapshot(id, by) -> the newest snapshot entry by that device, or null
//   dropPack(id, pack) -> removes it from the list and its record, and the blobs nothing else names
//   unpackIn({ id, ref, folder }) -> sync-work.js unpack's result plus manifest and root: a git pack into this
//     machine's checkout of its origin (the materializer's folder's checkout, else one of roots()), "Clone <name> on this
//     machine first" (CarryError 'no_checkout') when there is none; a plain one into the same folder under home
//   undo(result) -> sync-work.js undo
//   relocateLog({ id, dir, cwd }) -> the slug folder the log is in now: <projects>/<slug of cwd>, the log and its side
//     folder moved there (docs/sync-move-recipe.md: a log resumes from its own folder's slug folder only)
//   secretsIn({ id, from, fromName, into, manifest, account, root }) -> { notes, copied: { env, logins }, missing }:
//     /peer/env and /peer/logins from the machine that had it, over the link; env files never over a different one
//     (that one stays, the new one goes beside it as <name>.from-<machine>); a sign-in only where this machine has none
//   ready({ into, cwd, manifest, fromName, origin }) -> [{ what, how }]: the tools the repo names that are not here, the
//     sign-ins it needs and lacks, the env files it lacks, dependencies (installDeps starts them)
//   installDeps(into) -> the tool it started (in the background, logged to <dataDir>/carry.log) or null
//   noteText(f) -> the [Fleet View] note for Claude; saveNote(id, note), getNote(id), dropNote(id): <dataDir>/sync/
//     notes.json, until the Chat tab puts it in front of the next message there
//   snapshot({ id, file }) -> the entry uploaded, or null (not portable, nothing changed since the last one, or more
//     than a snapshot carries: 50 MB)
// Secrets never go in a log, a row, the page or an error: log lines name tools and files, never what is in them.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const P = require(path.join(__dirname, 'platform.js'));
const S = require(path.join(__dirname, 'sync-api.js'));
const K = require(path.join(__dirname, 'sync-crypto.js'));
const C = require(path.join(__dirname, 'sync-common.js'));
const W = require(path.join(__dirname, 'sync-work.js'));

const PIECE = 8 * 1024 * 1024;
const KEEP_SNAPSHOTS = 3;
const SNAP_CAP = 50 * 1024 * 1024; // the most one turn's snapshot carries (a move: sync-work.js's 200 MB)
const MOVE_PACK_MS = 24 * 3600e3; // a move's pack nobody dropped (its move failed) goes after this
const ENV_FILE_MAX = 1024 * 1024, ENV_TOTAL_MAX = 4 * 1024 * 1024;
const PEER_CALLS = 12, PEER_WINDOW_MS = 60e3;
const RUN_MS = 20e3, INSTALL_MS = 30 * 60e3;
const NOTES_MAX = 200;
const LOG_MAX = 256 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
const PACK_RE = /^[0-9a-f]{16}$/;
// a lockfile at the checkout's top -> the install that goes with it (sync-clone.js's list)
const INSTALLS = [
  ['package-lock.json', 'npm', ['ci']],
  ['pnpm-lock.yaml', 'pnpm', ['install', '--frozen-lockfile']],
  ['yarn.lock', 'yarn', ['install', '--frozen-lockfile']],
  ['bun.lock', 'bun', ['install']],
  ['bun.lockb', 'bun', ['install']],
];
// the tools a repo may name, and how to get each one
const TOOLS = {
  node: 'install Node.js (brew install node, or nodejs.org)', npm: 'it comes with Node.js', pnpm: 'npm install -g pnpm',
  yarn: 'npm install -g yarn', bun: 'install Bun (bun.sh)', git: 'install git', gh: 'install the GitHub CLI (brew install gh, or winget install GitHub.cli)',
  vercel: 'npm install -g vercel', supabase: 'install the Supabase CLI (brew install supabase/tap/supabase, or scoop install supabase)',
  p4: 'install the Helix command-line client (p4)', python3: 'install Python 3', docker: 'install Docker Desktop', deno: 'install Deno (deno.com)',
  go: 'install Go (go.dev)', cargo: 'install Rust (rustup.rs)', uv: 'install uv (docs.astral.sh/uv)', make: 'install make (Xcode command line tools, or build-essential)',
};
const ALIAS = { npx: 'node', uvx: 'uv', python: 'python3', pip: 'python3', pip3: 'python3', pnpx: 'pnpm', bunx: 'bun' };

class CarryError extends Error {
  constructor(message, code) { super(message); this.name = 'CarryError'; this.code = code; }
}
const lower = (s) => (typeof s === 'string' ? s.toLowerCase() : '');
const short = (id) => String(id || '').slice(0, 8);
const clip = (s, n = 200) => { const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const lst = (p) => { try { return fs.lstatSync(p); } catch { return null; } };
const readText = (p, max = 1024 * 1024) => { try { const st = fs.statSync(p); return st.isFile() && st.size <= max ? fs.readFileSync(p, 'utf8') : null; } catch { return null; } };
const fold = (p) => P.foldCase(path.resolve(p));
const under = (base, p) => { const r = path.relative(path.resolve(base), path.resolve(p)); return r === '' ? '' : r.split(path.sep)[0] === '..' || path.isAbsolute(r) ? null : r.split(path.sep).join('/'); };
const iso = (ms) => new Date(ms).toISOString();
const when = (ms) => `${iso(ms).slice(0, 16).replace('T', ' ')} UTC`;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
// a machine's name made safe for a file name
const safeName = (s) => String(s || 'other').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 40) || 'other';
const throughLink = (base, dest) => {
  const rel = path.relative(base, path.dirname(dest));
  if (!rel) return false;
  let d = base;
  for (const seg of rel.split(path.sep)) { d = path.join(d, seg); const st = lst(d); if (!st) return false; if (st.isSymbolicLink()) return true; }
  return false;
};

// ---------- running a command (the tools) ----------
function runDefault(file, args, o = {}) {
  return new Promise((resolve) => {
    let c;
    const opts = { cwd: o.cwd, env: o.env || process.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] };
    try {
      if (P.isWin && /\.(cmd|bat)$/i.test(file)) {
        const line = `"${[`"${file}"`, ...args.map((a) => `"${String(a).replace(/"/g, '""')}"`)].join(' ')}"`;
        c = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', line], { ...opts, windowsVerbatimArguments: true });
      } else c = spawn(file, args, opts);
    } catch (e) { resolve({ code: 1, out: '', err: e.message }); return; }
    let out = '', err = '', done = false;
    const keep = (s, b) => { const t = s + b.toString('utf8'); return t.length > LOG_MAX ? t.slice(-LOG_MAX) : t; };
    const finish = (code) => { if (done) return; done = true; clearTimeout(timer); resolve({ code, out, err }); };
    const timer = setTimeout(() => { try { c.kill(); } catch {} finish(124); }, o.timeoutMs || RUN_MS);
    c.stdout.on('data', (b) => { out = keep(out, b); });
    c.stderr.on('data', (b) => { err = keep(err, b); });
    c.on('error', (e) => { err += e.message; finish(1); });
    c.on('close', (code) => finish(code === null ? 1 : code));
    c.stdin.on('error', () => {});
    c.stdin.end(o.input == null ? undefined : o.input);
  });
}
function whichDefault(name) {
  if (typeof name !== 'string' || !/^[\w.+-]{1,80}$/.test(name)) return null;
  if (!P.isWin) return P.which(name);
  try {
    const r = require('child_process').spawnSync('where', [name], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    if (r.status !== 0) return null;
    return String(r.stdout).split(/\r?\n/).map((l) => l.trim()).find((l) => /\.(exe|cmd|bat)$/i.test(l)) || null;
  } catch { return null; }
}

function createCarry(o = {}) {
  const api = o.api;
  if (!api || typeof api.rest !== 'function') throw new S.SyncError('the carry needs sync-api.js\'s api', 0, 'bad_request');
  const key = o.key;
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new S.SyncError('the sync key must be 32 bytes', 0, 'bad_key');
  const dataDir = o.dataDir;
  const log = typeof o.log === 'function' ? (t) => { try { o.log(`sync-carry: ${t}`); } catch {} } : () => {};
  const now = typeof o.now === 'function' ? o.now : Date.now;
  const home = path.resolve(o.home || os.homedir());
  const env = o.env || process.env;
  const platform = o.platform || process.platform;
  const work = o.work || W;
  const which = typeof o.which === 'function' ? o.which : whichDefault;
  const run = typeof o.run === 'function' ? o.run : runDefault;
  const device = typeof o.device === 'function' ? o.device : () => null;
  const linkOf = typeof o.link === 'function' ? o.link : () => null;
  const rootsOf = typeof o.roots === 'function' ? o.roots : () => [];
  const packOpts = { home, ...(Number(o.cap) > 0 ? { cap: Number(o.cap) } : {}), ...(Array.isArray(o.p4Roots) ? { p4Roots: o.p4Roots } : {}) };
  // a turn's snapshot carries less than a move may (SNAP_CAP, o.snapCap in tests): one goes up at every turn's end
  // whose work changed, so a big untracked file is not sent again and again; a move still carries up to the cap
  const snapOpts = { ...packOpts, cap: Math.min(Number(o.snapCap) > 0 ? Number(o.snapCap) : SNAP_CAP, packOpts.cap || W.CAP) };
  const selfDir = typeof o.selfDir === 'string' && o.selfDir ? o.selfDir : __dirname; // the checkout Fleet View runs from

  // ---------- the list of a conversation's packs (the settings row work:<id>) ----------
  const chains = new Map();
  const serial = (k, fn) => { const p = (chains.get(k) || Promise.resolve()).then(fn); const tail = p.catch(() => {}); chains.set(k, tail); tail.then(() => { if (chains.get(k) === tail) chains.delete(k); }); return p; };
  const indexKey = (id) => `work:${id}`;
  async function readIndex(id) {
    const rows = await api.rest('GET', 'settings', { query: { select: 'key,value_enc', key: `eq.${indexKey(id)}` } });
    const row = Array.isArray(rows) ? rows[0] : null;
    let v = null;
    if (row) { try { v = JSON.parse(K.openText(row.value_enc, key, `setting:${indexKey(id)}`)); } catch { log(`${short(id)}: its pack list does not open with this key; started again`); } }
    const packs = v && v.v === 1 && Array.isArray(v.packs) ? v.packs.filter((p) => p && PACK_RE.test(p.pack) && p.blobs && typeof p.blobs === 'object') : [];
    return { v: 1, id, packs };
  }
  const writeIndex = (id, idx) => api.rest('POST', 'settings', {
    query: { on_conflict: 'user_id,key' }, prefer: 'resolution=merge-duplicates,return=minimal',
    body: { key: indexKey(id), value_enc: K.sealText(JSON.stringify(idx), key, `setting:${indexKey(id)}`) },
  });
  const blobRel = (id, h, n) => `w/${id}/b/${h}/${n}`;
  const recordRel = (id, pack) => `w/${id}/p/${pack}`;
  const pieces = (size) => Math.max(1, Math.ceil(size / PIECE));
  const storage = () => {
    if (!api.storage || typeof api.storage.upload !== 'function') throw new CarryError('this machine can\'t store packs (no storage)', 'no_storage');
    return api.storage;
  };
  // the objects of the packs named, less the blobs the packs left still name
  async function removeObjects(id, gone, left) {
    const keep = new Set(left.flatMap((p) => Object.keys(p.blobs)));
    const rels = [];
    for (const p of gone) {
      rels.push(recordRel(id, p.pack));
      for (const [h, size] of Object.entries(p.blobs)) if (!keep.has(h)) for (let n = 0; n < pieces(Number(size) || 0); n++) rels.push(blobRel(id, h, n));
    }
    for (let i = 0; i < rels.length; i += 900) {
      try { await storage().remove([...new Set(rels.slice(i, i + 900))]); } catch (e) { log(`${short(id)}: old pack objects could not be removed (${clip(e.message)})`); }
    }
  }
  // upload a pack (the blobs the list does not name yet) and add it to the list -> its entry
  function uploadPack(id, packed, kind, extra = {}) {
    return serial(id, async () => {
      const st = storage();
      const idx = await readIndex(id);
      const have = new Set(idx.packs.flatMap((p) => Object.keys(p.blobs)));
      const sizes = {};
      for (const [h, buf] of packed.blobs) {
        sizes[h] = buf.length;
        if (have.has(h)) continue;
        for (let n = 0, at = 0; n < pieces(buf.length); n++, at += PIECE) {
          const rel = blobRel(id, h, n);
          await st.upload(rel, K.sealChunk(buf.subarray(at, Math.min(at + PIECE, buf.length)), key, rel), { upsert: true });
        }
      }
      const pack = crypto.randomBytes(8).toString('hex');
      const record = Buffer.from(JSON.stringify({ v: 1, id, manifest: packed.manifest, blobs: sizes }), 'utf8');
      await st.upload(recordRel(id, pack), K.sealChunk(record, key, recordRel(id, pack)), { upsert: true });
      const entry = { pack, kind, by: device(), at: iso(now()), record: sha(record), blobs: sizes, summary: packed.manifest.summary || null, ...extra };
      // keep: the newest KEEP_SNAPSHOTS snapshots, and move packs younger than a day
      const all = [...idx.packs, entry];
      const snaps = all.filter((p) => p.kind === 'snapshot').sort((a, b) => (a.at < b.at ? 1 : -1));
      const oldSnaps = new Set(snaps.slice(KEEP_SNAPSHOTS).map((p) => p.pack));
      const t = now();
      const keepIt = (p) => !oldSnaps.has(p.pack) && !(p.kind === 'move' && p !== entry && t - Date.parse(p.at) > MOVE_PACK_MS);
      const left = all.filter(keepIt), gone = all.filter((p) => !keepIt(p));
      await writeIndex(id, { v: 1, id, packs: left });
      if (gone.length) await removeObjects(id, gone, left);
      return entry;
    });
  }
  async function fetchPack(id, ref) {
    if (!ref || !PACK_RE.test(String(ref.pack)) || !HEX64_RE.test(String(ref.record))) throw new CarryError('the pack reference is not one', 'bad_pack');
    const st = storage();
    const rec = K.openChunk(await st.download(recordRel(id, ref.pack)), key, recordRel(id, ref.pack));
    if (sha(rec) !== ref.record) throw new CarryError('the pack\'s record is not the one the move named', 'bad_pack');
    const r = JSON.parse(rec.toString('utf8'));
    if (!r || r.v !== 1 || lower(r.id) !== id || !r.manifest || !r.blobs || typeof r.blobs !== 'object') throw new CarryError('the pack\'s record is not one', 'bad_pack');
    const blobs = new Map();
    for (const [h, size] of Object.entries(r.blobs)) {
      if (!HEX64_RE.test(h) || !Number.isSafeInteger(size) || size < 0) throw new CarryError('the pack names a bad blob', 'bad_pack');
      const parts = [];
      for (let n = 0; n < pieces(size); n++) parts.push(K.openChunk(await st.download(blobRel(id, h, n)), key, blobRel(id, h, n)));
      const buf = Buffer.concat(parts);
      if (buf.length !== size || sha(buf) !== h) throw new CarryError(`blob ${h.slice(0, 8)} is not what the pack says`, 'bad_pack');
      blobs.set(h, buf);
    }
    return { manifest: r.manifest, blobs };
  }
  async function newestSnapshot(id, by) {
    const idx = await readIndex(id);
    const list = idx.packs.filter((p) => p.kind === 'snapshot' && (!by || lower(p.by) === lower(by))).sort((a, b) => (a.at < b.at ? 1 : -1));
    return list[0] || null;
  }
  function dropPack(id, pack) {
    return serial(id, async () => {
      const idx = await readIndex(id);
      const gone = idx.packs.filter((p) => p.pack === pack);
      if (!gone.length) return false;
      const left = idx.packs.filter((p) => p.pack !== pack);
      await writeIndex(id, { v: 1, id, packs: left });
      await removeObjects(id, gone, left);
      return true;
    });
  }

  // ---------- A: the work out ----------
  // another live chat here works in that checkout or worktree (the host's list: alive, its cwd inside root)
  const sharedIn = (root, id, list) => !!root && (Array.isArray(list) ? list : []).some((p) => p && p.alive && lower(p.id) !== id && typeof p.cwd === 'string' && p.cwd && under(root, p.cwd) !== null);
  // The env files a checkout (or a plain folder) has that git does not carry: .env, .env.local, .env.* anywhere in it
  // (most are ignored, so a work pack never names them), never inside node_modules, .git, the worktrees and build
  // folders, at most 6 folders deep and 50 files, and never a tracked one (git has that). -> [path from base, with /]
  const ENV_SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.turbo', '.venv', 'venv', '__pycache__', 'coverage', 'target', '.cache']);
  async function envDiscover(base, git) {
    const found = [];
    let dirs = 0;
    const walk = (abs, rel, depth) => {
      if (depth > 6 || ++dirs > 3000 || found.length >= 50) return;
      let ents = [];
      try { ents = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) {
          if (ENV_SKIP.has(e.name) || r === '.claude/worktrees') continue;
          walk(path.join(abs, e.name), r, depth + 1);
        } else if (e.isFile() && W.isEnvName(e.name) && found.length < 50) found.push(r);
      }
    };
    walk(path.resolve(base), '', 0);
    if (!git || !found.length) return found;
    const r = await runDefault('git', ['ls-files', '-z', '--', ...found.map((x) => `:(literal)${x}`)], { cwd: base, timeoutMs: 30e3, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' } });
    const tracked = new Set(r.code === 0 ? String(r.out).split('\0').filter(Boolean) : found);
    return found.filter((x) => !tracked.has(x));
  }
  // Untracked files that look like secrets (relay.js secretName: credentials, keys, .npmrc, service accounts…, or a
  // private key in their text) never go into a pack, which is stored in Supabase: they stay on this machine, named in
  // left (the note says so). -> the pack without them, and left
  function withoutSecrets(packed) {
    const m = packed.manifest, R = require(path.join(__dirname, 'relay.js'));
    const textSecret = /-----BEGIN [A-Z ]*PRIVATE KEY-----|"private_key"\s*:|"type"\s*:\s*"service_account"/;
    const left = [], keep = [];
    for (const e of m.untracked) {
      const b = packed.blobs.get(e.sha256);
      const secret = e.path.split('/').some((seg) => R.secretName(seg)) || (b && b.length <= 1024 * 1024 && textSecret.test(b.toString('latin1')));
      (secret ? left : keep).push(e);
    }
    if (!left.length) return { packed, left: [] };
    const used = new Set([m.bundle, m.staged, m.unstaged, ...keep.map((e) => e.sha256)].filter(Boolean));
    const blobs = new Map([...packed.blobs].filter(([h]) => used.has(h)));
    const bytes = [...blobs.values()].reduce((n, b) => n + b.length, 0);
    const manifest = { ...m, untracked: keep, summary: { ...m.summary, files: Math.max(0, m.summary.files - left.length), bytes }, notes: [...m.notes, ...left.map((e) => `not carried (it looks like a secret): ${e.path}`)] };
    return { packed: { manifest, blobs }, left: left.map((e) => e.path) };
  }
  async function packOut(f) {
    const id = lower(f.id);
    if (!f.canCarry) return { work: { none: `${f.toName || 'the other machine'} runs an older Fleet View, so the work stays here` }, local: null };
    const cwd = f.file ? C.lastMeta(f.file).cwd : null;
    if (typeof cwd !== 'string' || !cwd || !isDir(cwd)) return { work: { none: 'its folder is not on this machine' }, local: null };
    const info = await work.inspect(cwd, packOpts);
    if (info.kind !== 'portable') return { work: { none: info.why || 'its folder stays on this machine' }, local: null };
    let packed;
    try { packed = await work.pack(cwd, packOpts); } catch (e) {
      if (e && e.code === 'refused') {
        if (f.noWork) return { work: { refused: clip(e.message, 300) }, local: null };
        throw new CarryError(clip(e.message, 300), 'refused');
      }
      throw e;
    }
    const ws = withoutSecrets(packed);
    packed = ws.packed;
    const m = packed.manifest;
    const envBase = m.kind === 'plain' ? path.join(home, ...String(m.rel || '').split('/').filter(Boolean)) : info.root;
    const shared = m.kind === 'git' && sharedIn(info.root, id, f.list);
    let env = m.env.slice();
    try { env = [...new Set([...env, ...(await envDiscover(envBase, m.kind === 'git'))])].slice(0, 50); } catch {}
    const entry = await uploadPack(id, packed, 'move');
    log(`${short(id)}: packed its work for ${f.toName || 'the other machine'} (${plural(m.summary.commits, 'commit', 'commits')}, ${plural(m.summary.files, 'file', 'files')}, ${m.summary.bytes} bytes${env.length ? `; ${plural(env.length, 'env file', 'env files')} go over the link` : ''}${ws.left.length ? `; ${plural(ws.left.length, 'file that looks like a secret stays', 'files that look like secrets stay')} here` : ''})`);
    return {
      // envPaths: the env files' paths only (what is in them goes over the link, /peer/env), for the ready check there;
      // left: untracked files that look like secrets, which stay here (never in storage)
      work: { pack: entry.pack, record: entry.record, kind: m.kind, branch: m.branch, summary: m.summary, notes: m.notes.slice(0, 10), shared, envPaths: env, left: ws.left.slice(0, 20) },
      local: { cwd, root: info.root, kind: m.kind, envBase, env, pack: entry.pack, left: ws.left.slice() },
    };
  }
  async function putAwayAfter(local, f = {}) {
    if (!local || local.kind !== 'git') return { stashed: null, why: 'nothing to put away' };
    // never the checkout this Fleet View runs from (its own files would change under the running server); o.selfDir
    // stands in for it in tests
    if (fold(local.root) === fold(selfDir)) {
      log(`${short(f.id)}: its changes stay in ${local.root}: Fleet View runs from that checkout`);
      return { stashed: null, why: 'Fleet View runs from that checkout' };
    }
    if (sharedIn(local.root, lower(f.id), f.list)) {
      log(`${short(f.id)}: its changes stay in ${local.root}: another chat here works in it`);
      return { stashed: null, why: 'another chat here works in that checkout' };
    }
    const stashed = await work.putAway(local.cwd, `fleet-view: moved to ${f.toName || 'another machine'} ${iso(now())} (${lower(f.id)})`, { keep: local.left || [] });
    log(`${short(f.id)}: its changes here are put away${stashed ? ` (stash ${stashed.slice(0, 8)})` : ' (there were none)'}: they went to ${f.toName || 'the other machine'}`);
    return { stashed, why: null };
  }
  function envFiles(local) {
    if (!local || !Array.isArray(local.env) || !local.envBase) return [];
    const base = path.resolve(local.envBase), files = [];
    let total = 0;
    for (const rel of local.env) {
      if (!W.safeRel(rel) || !W.envPath(rel)) continue;
      const abs = path.join(base, ...rel.split('/'));
      if (throughLink(base, abs)) continue;
      const st = lst(abs);
      if (!st || !st.isFile() || st.size > ENV_FILE_MAX || total + st.size > ENV_TOTAL_MAX) continue;
      const buf = fs.readFileSync(abs);
      total += buf.length;
      files.push({ path: rel, b64: buf.toString('base64') });
    }
    return files;
  }

  // ---------- the tools' sign-ins ----------
  const ghDir = () => env.GH_CONFIG_DIR || (platform === 'win32' ? path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'GitHub CLI')
    : path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'gh'));
  const vercelFiles = () => {
    const list = [];
    if (platform === 'darwin') list.push(path.join(home, 'Library', 'Application Support', 'com.vercel.cli', 'auth.json'));
    else if (platform === 'win32') {
      list.push(path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'com.vercel.cli', 'Data', 'auth.json'));
      list.push(path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'com.vercel.cli', 'Data', 'auth.json'));
    } else list.push(path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'com.vercel.cli', 'auth.json'));
    list.push(path.join(home, '.vercel', 'auth.json'), path.join(home, '.now', 'auth.json'));
    return list;
  };
  const tokenOk = (t) => typeof t === 'string' && /^[A-Za-z0-9_.\-]{8,500}$/.test(t);
  function vercelToken() {
    for (const f of vercelFiles()) {
      try { const j = JSON.parse(readText(f) || 'null'); if (j && tokenOk(j.token)) return j.token; } catch {}
    }
    return null;
  }
  const supabaseFile = () => path.join(home, '.supabase', 'access-token');
  async function supabaseToken() {
    const t = (readText(supabaseFile(), 4096) || '').trim();
    if (tokenOk(t)) return t;
    if (platform !== 'darwin') return null; // Windows' Credential Manager is not read here
    for (const account of ['access-token', 'supabase']) {
      const r = await run('/usr/bin/security', ['find-generic-password', '-s', 'Supabase CLI', '-a', account, '-w'], { timeoutMs: 10e3 });
      let v = r.code === 0 ? String(r.out).trim() : '';
      if (v.startsWith('go-keyring-base64:')) v = Buffer.from(v.slice(18), 'base64').toString('utf8');
      else if (v.startsWith('go-keyring-encoded:')) v = Buffer.from(v.slice(19), 'hex').toString('utf8');
      if (tokenOk(v)) return v;
    }
    return null;
  }
  async function ghToken() {
    const gh = which('gh');
    if (!gh) return null;
    const r = await run(gh, ['auth', 'token'], { timeoutMs: 15e3 });
    const t = r.code === 0 ? String(r.out).trim() : '';
    return tokenOk(t) ? t : null;
  }
  const ghUser = () => {
    const t = readText(path.join(ghDir(), 'hosts.yml'), 64 * 1024) || '';
    const m = /^github\.com:\s*\n(?:[ \t]+.*\n)*?[ \t]+user:\s*([A-Za-z0-9-]{1,39})\s*$/m.exec(t.replace(/\r\n/g, '\n') + '\n');
    return m ? m[1] : null;
  };
  const npmrcFile = () => env.NPM_CONFIG_USERCONFIG || env.npm_config_userconfig || path.join(home, '.npmrc');
  // the registries a checkout uses: its .npmrc's registry lines, and npm's own
  function registriesOf(root) {
    const set = new Set(['registry.npmjs.org']);
    const t = root ? readText(path.join(root, '.npmrc'), 64 * 1024) || '' : '';
    for (const m of t.matchAll(/^\s*(?:@[\w.-]+:)?registry\s*=\s*https?:\/\/([^/\s]+)/gim)) set.add(m[1].toLowerCase());
    return set;
  }
  const npmAuthLine = (line) => /^\s*\/\/([^/\s:]+)[^\s]*:(?:_authToken|_auth|_password|username)\s*=/.exec(line);
  const claudeJson = (account) => (account === 'a' || account === 'A' ? path.join(home, '.claude-a', '.claude.json') : path.join(home, '.claude.json'));
  const remoteMcp = (cfg) => !!cfg && typeof cfg === 'object' && (cfg.type === 'http' || cfg.type === 'sse' || (typeof cfg.url === 'string' && !cfg.command));
  // the project entries of a .claude.json for any of these folders (its keys use / on every platform)
  const projectEntries = (j, folders) => {
    const want = new Set(folders.filter(Boolean).map((f) => P.foldCase(path.resolve(f).replace(/\\/g, '/'))));
    return Object.entries((j && j.projects) || {}).filter(([k]) => want.has(P.foldCase(k.replace(/\\/g, '/').replace(/\/+$/, '')))).map(([, v]) => v || {});
  };
  function mcpOf(account, folders) {
    let j = null;
    try { j = JSON.parse((readText(claudeJson(account), 32 * 1024 * 1024) || 'null').replace(/^﻿/, '')); } catch {}
    if (!j) return null;
    const split = (servers) => {
      const remote = {}, local = [];
      for (const [name, cfg] of Object.entries(servers || {})) {
        if (!/^[\w.-]{1,80}$/.test(name)) continue;
        if (remoteMcp(cfg)) remote[name] = cfg; else local.push(name);
      }
      return { remote, local };
    };
    const user = split(j.mcpServers);
    const proj = split(Object.assign({}, ...projectEntries(j, folders).map((v) => v.mcpServers || {})));
    return { user: user.remote, project: proj.remote, local: [...new Set([...user.local, ...proj.local])] };
  }
  async function logins(local, account) {
    const out = {};
    const gh = await ghToken();
    if (gh) out.gh = { token: gh, user: ghUser() };
    const v = vercelToken();
    if (v) out.vercel = { token: v };
    const sb = await supabaseToken();
    if (sb) out.supabase = { token: sb };
    const regs = registriesOf(local && local.root);
    const lines = (readText(npmrcFile(), 256 * 1024) || '').split(/\r?\n/).filter((l) => { const m = npmAuthLine(l); return m && regs.has(m[1].toLowerCase()); });
    if (lines.length) out.npm = lines.slice(0, 20);
    const mcp = mcpOf(account, [local && local.root, local && local.cwd]);
    if (mcp && (Object.keys(mcp.user).length || Object.keys(mcp.project).length || mcp.local.length)) out.mcp = mcp;
    return out;
  }
  const peerCalls = new Map(); // peer -> [times]
  function peerAllowed(peer) {
    const t = now(), list = (peerCalls.get(peer) || []).filter((x) => t - x < PEER_WINDOW_MS);
    if (list.length >= PEER_CALLS) { peerCalls.set(peer, list); return false; }
    list.push(t);
    peerCalls.set(peer, list);
    return true;
  }

  // ---------- B: laying the work down ----------
  async function rootFor(origin, folder) {
    const tryOne = async (f) => {
      if (typeof f !== 'string' || !f || !isDir(f)) return null;
      try { const r = await C.repoOf(f, { fresh: true }); return r && r.origin === origin ? r.mainRoot : null; } catch { return null; }
    };
    const a = await tryOne(folder);
    if (a) return a;
    let list = [];
    try { list = (await rootsOf()) || []; } catch {}
    for (const r of Array.isArray(list) ? list : []) { const b = await tryOne(r); if (b) return b; }
    return null;
  }
  const repoName = (origin) => String(origin || '').split('/').filter(Boolean).pop() || 'its repo';
  // the checkout folder lays the work down in place (its way back to where it began: the materializer's folder, its
  // checkout's top) when it is on the work's branch, clean but for env files, and no other live chat here works in it;
  // else (null) the chat gets a worktree of its own
  async function inPlace(folder, branch, id, list) {
    if (!folder || !branch || !isDir(folder)) return null;
    const g = (args) => runDefault('git', args, { cwd: folder, timeoutMs: 30e3, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' } });
    const top = await g(['rev-parse', '--show-toplevel']);
    const b = await g(['symbolic-ref', '-q', '--short', 'HEAD']);
    if (top.code !== 0 || b.code !== 0 || String(b.out).trim() !== branch) return null;
    const dir = path.resolve(String(top.out).trim());
    const st = await g(['status', '--porcelain=v1', '-z', '--untracked-files=normal']);
    const dirty = st.code !== 0 || String(st.out).split('\0').filter(Boolean).some((e) => !(e.startsWith('?? ') && W.envPath(e.slice(3).replace(/\/$/, ''))));
    return dirty || sharedIn(dir, id, list) ? null : dir;
  }
  async function unpackIn(f) {
    const id = lower(f.id);
    const { manifest, blobs } = await fetchPack(id, f.ref);
    if (manifest.kind === 'git') {
      const root = await rootFor(manifest.origin, f.folder);
      if (!root) throw new CarryError(`Clone ${repoName(manifest.origin)} on this machine first (the Sync card's Repos), then try again`, 'no_checkout');
      const into = await inPlace(f.folder, manifest.branch, id, f.list);
      const res = await work.unpack(manifest, blobs, { root, home, ...(into ? { into } : {}) });
      return { ...res, manifest, root };
    }
    const res = await work.unpack(manifest, blobs, { home });
    return { ...res, manifest, root: null };
  }
  const undo = (res) => work.undo(res);
  // the log (and its side folder) into the slug folder of the folder it resumes in
  function relocateLog({ id, dir, cwd }) {
    const projects = path.dirname(path.resolve(dir));
    const target = path.join(projects, C.slugOf(cwd));
    if (fold(target) === fold(dir)) return path.resolve(dir);
    const from = path.join(dir, `${id}.jsonl`), to = path.join(target, `${id}.jsonl`);
    if (lst(to)) throw new CarryError('a copy of its log is already where it resumes', 'conflict');
    fs.mkdirSync(target, { recursive: true });
    fs.renameSync(from, to);
    const side = path.join(dir, id);
    if (isDir(side) && !lst(path.join(target, id))) fs.renameSync(side, path.join(target, id));
    return target;
  }
  function writeEnv(into, files, fromName, notes) {
    const wrote = [];
    for (const f of Array.isArray(files) ? files : []) {
      if (!f || !W.safeRel(f.path) || !W.envPath(f.path) || typeof f.b64 !== 'string') continue;
      const buf = Buffer.from(f.b64, 'base64');
      if (buf.length > ENV_FILE_MAX) continue;
      let dest = path.join(into, ...f.path.split('/'));
      if (throughLink(into, dest)) { notes.push(`${f.path} not written: a link is in its way`); continue; }
      const st = lst(dest);
      if (st) {
        if (st.isFile() && sha(fs.readFileSync(dest)) === sha(buf)) continue;
        dest = `${dest}.from-${safeName(fromName)}`;
        if (lst(dest)) continue;
        notes.push(`${f.path} here differs from ${fromName}'s: kept, and ${fromName}'s is beside it as ${path.basename(dest)}`);
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, buf, { mode: 0o600 });
      wrote.push(f.path);
    }
    return wrote;
  }
  async function installLogins(l, f, copied, missing, notes) {
    if (!l || typeof l !== 'object') return;
    if (l.gh && tokenOk(l.gh.token)) {
      const gh = which('gh');
      if (!gh) missing.push({ what: 'gh', how: TOOLS.gh });
      else if (!(await ghToken())) {
        const r = await run(gh, ['auth', 'login', '--with-token', '--hostname', 'github.com'], { input: `${l.gh.token}\n`, timeoutMs: 30e3 });
        if (r.code === 0) copied.push('GitHub (gh)'); else notes.push('the GitHub sign-in could not be copied: run gh auth login');
      }
    }
    if (l.vercel && tokenOk(l.vercel.token) && !vercelToken()) {
      const file = vercelFiles()[0];
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, `${JSON.stringify({ '// Note': 'This is your Vercel credentials file. DO NOT SHARE!', '// Docs': 'https://vercel.com/docs/projects/project-configuration/global-configuration#auth.json', token: l.vercel.token }, null, 2)}\n`, { mode: 0o600 });
      copied.push('Vercel');
    }
    if (l.supabase && tokenOk(l.supabase.token) && !(await supabaseToken())) {
      // the file the Supabase CLI reads when its keyring has none (never on a command line, which other processes see)
      fs.mkdirSync(path.dirname(supabaseFile()), { recursive: true, mode: 0o700 });
      fs.writeFileSync(supabaseFile(), l.supabase.token, { mode: 0o600 });
      copied.push('Supabase');
    }
    if (Array.isArray(l.npm) && l.npm.length) {
      const file = npmrcFile();
      const had = readText(file, 256 * 1024) || '';
      const haveKeys = new Set(had.split(/\r?\n/).map((x) => { const m = /^\s*(\/\/[^=\s]+)\s*=/.exec(x); return m ? m[1].toLowerCase() : null; }).filter(Boolean));
      const add = l.npm.filter((x) => typeof x === 'string' && npmAuthLine(x) && !/[\r\n]/.test(x)).filter((x) => !haveKeys.has(/^\s*(\/\/[^=\s]+)\s*=/.exec(x)[1].toLowerCase()));
      if (add.length) {
        fs.writeFileSync(file, `${had}${had && !had.endsWith('\n') ? '\n' : ''}${add.join('\n')}\n`, { mode: 0o600 });
        copied.push('npm');
      }
    }
    if (l.mcp && typeof l.mcp === 'object') {
      const here = mcpOf(f.account, [f.into]) || { user: {}, project: {}, local: [] };
      let j = null;
      try { j = JSON.parse((readText(claudeJson(f.account), 32 * 1024 * 1024) || 'null').replace(/^﻿/, '')); } catch {}
      const userHere = new Set(Object.keys((j && j.mcpServers) || {}));
      const projHere = new Set(Object.keys(Object.assign({}, ...projectEntries(j, [f.into]).map((v) => v.mcpServers || {}))));
      const claude = which('claude');
      const cenv = { ...env };
      if (f.account === 'a' || f.account === 'A') cenv.CLAUDE_CONFIG_DIR = path.join(home, '.claude-a'); else delete cenv.CLAUDE_CONFIG_DIR;
      const added = [];
      for (const [scope, list, have] of [['user', l.mcp.user, userHere], ['local', l.mcp.project, projHere]]) {
        for (const [name, cfg] of Object.entries(list || {})) {
          if (!/^[\w.-]{1,80}$/.test(name) || !remoteMcp(cfg) || have.has(name)) continue;
          if (!claude) { missing.push({ what: `MCP server ${name}`, how: `claude mcp add-json --scope ${scope} ${name} '<its config on ${f.fromName}>'` }); continue; }
          const r = await run(claude, ['mcp', 'add-json', '--scope', scope, name, JSON.stringify(cfg)], { cwd: f.into, env: cenv, timeoutMs: 30e3 });
          if (r.code === 0) added.push(name); else missing.push({ what: `MCP server ${name}`, how: `add it here with claude mcp add-json (it could not be added: exit ${r.code})` });
        }
      }
      if (added.length) copied.push(`MCP ${added.join(', ')}`);
      for (const name of Array.isArray(l.mcp.local) ? l.mcp.local.slice(0, 20) : []) {
        if (typeof name === 'string' && /^[\w.-]{1,80}$/.test(name) && !here.local.includes(name) && !userHere.has(name) && !projHere.has(name)) {
          missing.push({ what: `MCP server ${name}`, how: `a local command on ${f.fromName}: set it up here with claude mcp add` });
        }
      }
    }
  }
  // the env files a move named: final.work.envPaths (the ignored ones too), else the manifest's own (unignored ones)
  const envList = (f) => (Array.isArray(f.envPaths) ? f.envPaths : f.manifest && Array.isArray(f.manifest.env) ? f.manifest.env : []).filter((x) => typeof x === 'string');
  async function secretsIn(f) {
    const notes = [], missing = [], copied = { env: [], logins: [] };
    const link = linkOf();
    const name = f.fromName || 'the other machine';
    if (!link || typeof link.call !== 'function') {
      notes.push(`env files and sign-ins were not copied: link this machine with ${name} in the Sync card`);
      return { notes, copied, missing, linked: false };
    }
    const online = typeof link.online === 'function' ? link.online(f.from) : null;
    if (online === false || online === null) {
      notes.push(online === false ? `env files and sign-ins were not copied: ${name} is offline` : `env files and sign-ins were not copied: this machine is not linked with ${name} (the Sync card)`);
      return { notes, copied, missing, linked: online !== null };
    }
    const id = lower(f.id);
    if (envList(f).length) {
      const r = await link.call(f.from, 'POST', '/peer/env', { b: { id }, timeoutMs: 45e3 });
      if (r && r.s === 200 && r.b && Array.isArray(r.b.files)) copied.env = writeEnv(f.into, r.b.files, name, notes);
      else notes.push(`the env files did not come from ${name} (${clip((r && r.b && (r.b.message || r.b.code)) || `answer ${r && r.s}`, 120)})`);
    }
    const r2 = await link.call(f.from, 'POST', '/peer/logins', { b: { id }, timeoutMs: 45e3 });
    if (r2 && r2.s === 200 && r2.b && r2.b.logins) {
      try { await installLogins(r2.b.logins, { ...f, fromName: name }, copied.logins, missing, notes); } catch (e) { notes.push(`a sign-in could not be copied (${clip(e.message, 120)})`); }
    } else notes.push(`the sign-ins did not come from ${name} (${clip((r2 && r2.b && (r2.b.message || r2.b.code)) || `answer ${r2 && r2.s}`, 120)})`);
    if (copied.env.length || copied.logins.length) log(`${short(id)}: copied from ${name}: ${[...copied.env, ...copied.logins].join(', ')}`);
    return { notes, copied, missing, linked: true };
  }

  // ---------- the ready check ----------
  function toolsNamed(into, cwd) {
    const need = new Set();
    const add = (w) => { const t = ALIAS[w] || w; if (TOOLS[t]) need.add(t); };
    const pkg = readText(path.join(into, 'package.json'), 1024 * 1024);
    if (pkg) {
      add('node');
      for (const [file, tool] of INSTALLS.map(([fl, t]) => [fl, t])) if (lst(path.join(into, file))) add(tool);
      try { const j = JSON.parse(pkg); for (const v of Object.values((j && j.scripts) || {})) for (const w of String(v).split(/[\s;&|()]+/)) add(w); } catch {}
    }
    for (const f of [path.join(into, 'CLAUDE.md'), cwd && path.join(cwd, 'CLAUDE.md')].filter(Boolean)) {
      const t = readText(f, 512 * 1024);
      if (!t) continue;
      for (const m of t.matchAll(/`([a-z][\w.-]*)(?=[\s`])/g)) add(m[1]);
      for (const block of t.matchAll(/```[^\n]*\n([\s\S]*?)```/g)) for (const line of block[1].split('\n')) { const w = line.trim().split(/\s+/)[0]; if (w) add(w); }
    }
    try {
      const j = JSON.parse(readText(path.join(into, '.mcp.json'), 256 * 1024) || 'null');
      for (const cfg of Object.values((j && j.mcpServers) || {})) if (cfg && typeof cfg.command === 'string') add(path.basename(cfg.command).replace(/\.(exe|cmd)$/i, ''));
    } catch {}
    return need;
  }
  async function ready(f) {
    const into = f.into, missing = [];
    if (!into || !isDir(into)) return missing;
    const need = toolsNamed(into, f.cwd);
    for (const t of need) if (!which(t)) missing.push({ what: t, how: TOOLS[t] });
    if (need.has('gh') && which('gh') && !(await ghToken())) missing.push({ what: 'the GitHub sign-in', how: 'gh auth login' });
    if ((need.has('vercel') || lst(path.join(into, 'vercel.json')) || isDir(path.join(into, '.vercel'))) && !vercelToken()) missing.push({ what: 'the Vercel sign-in', how: 'vercel login' });
    if ((need.has('supabase') || lst(path.join(into, 'supabase', 'config.toml'))) && !(await supabaseToken())) missing.push({ what: 'the Supabase sign-in', how: 'supabase login' });
    for (const rel of envList(f)) {
      if (W.safeRel(rel) && !lst(path.join(into, ...rel.split('/')))) missing.push({ what: rel, how: `copy it from ${f.fromName || 'the other machine'}, or link the machines in the Sync card and move it again` });
    }
    const seen = new Set();
    return missing.filter((m) => { const k = m.what.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 20);
  }
  let installing = Promise.resolve();
  function installDeps(into) {
    if (!into || !lst(path.join(into, 'package.json')) || isDir(path.join(into, 'node_modules'))) return null;
    const hit = INSTALLS.find(([file]) => lst(path.join(into, file)));
    if (!hit) return null;
    const [, tool, args] = hit;
    const bin = which(tool);
    if (!bin) return null;
    const logFile = path.join(dataDir, 'carry.log');
    installing = installing.then(async () => {
      const r = await run(bin, args, { cwd: into, timeoutMs: INSTALL_MS });
      try { fs.appendFileSync(logFile, `\n--- ${iso(now())} ${tool} ${args.join(' ')} in ${into}: exit ${r.code}\n${String(r.out).slice(-8000)}${String(r.err).slice(-8000)}\n`); } catch {}
      log(`${tool} ${args.join(' ')} in ${into}: ${r.code === 0 ? 'done' : `exit ${r.code} (see carry.log)`}`);
    }).catch(() => {});
    return tool;
  }

  // ---------- the note for Claude ----------
  function noteText(f) {
    const from = f.fromName || 'the other machine', to = f.toName || 'this machine';
    const s = [`[Fleet View] This chat moved from ${from} to ${to} at ${when(f.at || now())}.`];
    const w = f.work || null, res = f.res || null;
    if (res && res.manifest && res.manifest.kind === 'git') {
      s.push(`It now runs in ${f.cwd}${res.root && fold(res.into) !== fold(res.root) ? ` (a worktree of ${res.root})` : ''}${res.branch ? `, on branch ${res.branch}` : ', on a detached head'}.`);
      const sm = res.manifest.summary || {};
      s.push(f.snapshot ? `Its work came from ${from}'s last snapshot, as of ${when(Date.parse(f.snapshot.at))}: ${plural(sm.commits || 0, 'unpushed commit', 'unpushed commits')} and ${plural(sm.files || 0, 'changed file', 'changed files')}, laid down and checked. Anything newer is still on ${from}.`
        : `Its work came with it: ${plural(sm.commits || 0, 'unpushed commit', 'unpushed commits')} and ${plural(sm.files || 0, 'changed file', 'changed files')}, laid down and checked.`);
      if (w && w.shared) s.push(`The same changes also stay in ${from}'s checkout, where another chat works.`);
    } else if (res && res.manifest && res.manifest.kind === 'plain') {
      s.push(`It now runs in ${f.cwd}; ${plural((res.manifest.summary || {}).files || 0, 'file', 'files')} of its folder came with it${f.snapshot ? ` (as of ${when(Date.parse(f.snapshot.at))}; anything newer is still on ${from})` : ''}, and the originals stay on ${from}.`);
    } else {
      s.push(`It now runs in ${f.cwd}.`);
      if (w && w.none) s.push(`Its files stayed on ${from} (${w.none}): only the conversation moved.`);
      else if (w && w.refused) s.push(`Its work did not come (${w.refused}): those changes are still on ${from}.`);
      else if (f.forced) s.push(`${from} was offline, so only the conversation came (as of its last upload): its work is still on ${from}.`);
      else s.push(`${from} runs an older Fleet View, so its work did not come with it: it is still on ${from}.`);
    }
    for (const n of (res && Array.isArray(res.notes) ? res.notes : []).slice(0, 2)) s.push(`Note: ${n}.`);
    const left = (w && Array.isArray(w.left) ? w.left : f.snapshot && Array.isArray(f.snapshot.left) ? f.snapshot.left : []).filter((x) => typeof x === 'string');
    if (left.length) s.push(`Not carried, as ${left.length === 1 ? 'it looks' : 'they look'} like ${left.length === 1 ? 'a secret' : 'secrets'} (still on ${from}): ${left.slice(0, 5).join(', ')}.`);
    const copied = f.copied ? [...(f.copied.env || []), ...(f.copied.logins || []).map((x) => `the ${x} sign-in`)] : [];
    if (copied.length) s.push(`Copied from ${from}: ${copied.join(', ')}.`);
    if (Array.isArray(f.missing) && f.missing.length) s.push(`Missing here: ${f.missing.slice(0, 8).map((m) => `${m.what} (${m.how})`).join('; ')}.`);
    if (f.installing) s.push(`Its dependencies are installing in the background (${f.installing}).`);
    s.push(`Anything that was running on ${from} (a dev server, a watcher) did not move: start it again here if you need it.`);
    return s.join(' ').slice(0, 4000);
  }
  const notes = notesStore(dataDir, now);
  const saveNote = (id, note) => notes.save(id, note), getNote = (id) => notes.get(id), dropNote = (id) => notes.drop(id);

  // ---------- snapshots: a portable chat's work at the end of a turn ----------
  const lastSig = new Map(); // id -> the last snapshot's signature here
  async function signature(info) {
    const h = crypto.createHash('sha256');
    if (info.git) {
      h.update(String(info.head || ''));
      const r = await runDefault('git', ['status', '--porcelain=v1', '-z', '--untracked-files=normal'], { cwd: info.root, timeoutMs: 30e3, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' } });
      if (r.code !== 0) return null;
      h.update(r.out);
      // what status lists is the same while a changed file keeps changing: its size and time too
      for (const e of String(r.out).split('\0').filter(Boolean)) {
        const st = lst(path.join(info.root, e.slice(3)));
        if (st) h.update(`|${st.size}|${st.mtimeMs}`);
      }
      return h.digest('hex');
    }
    const dir = path.join(info.root, ...String(info.rel || '').split('/').filter(Boolean));
    let n = 0;
    const walk = (abs, rel) => {
      let ents = [];
      try { ents = fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1)); } catch { return; }
      for (const e of ents) {
        if (++n > 20000) return;
        if (e.isDirectory() && (e.name === 'node_modules' || e.name === '.git')) continue;
        const p = path.join(abs, e.name);
        if (e.isDirectory()) { walk(p, `${rel}/${e.name}`); continue; }
        const st = lst(p);
        if (st) h.update(`${rel}/${e.name}|${st.size}|${st.mtimeMs}\n`);
      }
    };
    walk(dir, '');
    return h.digest('hex');
  }
  async function snapshot(f) {
    const id = lower(f.id);
    const cwd = f.file ? C.lastMeta(f.file).cwd : null;
    if (typeof cwd !== 'string' || !cwd || !isDir(cwd)) return null;
    const info = await work.inspect(cwd, packOpts);
    if (info.kind !== 'portable') return null;
    const sig = await signature(info);
    if (!sig) return null;
    if (!lastSig.has(id)) {
      const prev = await newestSnapshot(id, device());
      if (prev && prev.sig) lastSig.set(id, prev.sig);
    }
    if (lastSig.get(id) === sig) return null;
    let packed;
    try { packed = await work.pack(cwd, snapOpts); } catch (e) {
      if (e && e.code === 'refused') { lastSig.set(id, sig); log(`${short(id)}: no snapshot (${clip(e.message, 120)})`); return null; }
      throw e;
    }
    const ws = withoutSecrets(packed);
    packed = ws.packed;
    const entry = await uploadPack(id, packed, 'snapshot', { sig, left: ws.left.slice(0, 20) });
    lastSig.set(id, sig);
    log(`${short(id)}: a snapshot of its work (${plural(packed.manifest.summary.files, 'file', 'files')}) for a pickup while this machine is off`);
    return entry;
  }

  return {
    packOut, putAwayAfter, envFiles, logins, peerAllowed, fetchPack, newestSnapshot, dropPack, unpackIn, undo, relocateLog,
    secretsIn, ready, installDeps, noteText, saveNote, getNote, dropNote, snapshot, readIndex,
  };
}

// The notes a move leaves for Claude, until the Chat tab puts one in front of the next message there:
// <dataDir>/sync/notes.json { v: 1, notes: { <id>: { note, at } } }, the newest 200. A file of its own, so the page
// reads and drops one whether sync runs or not. -> { save(id, note), get(id) -> note | null, drop(id) -> bool }
function notesStore(dataDir, now = Date.now) {
  const file = () => path.join(S.syncDir(dataDir), 'notes.json');
  const read = () => { const j = C.readState(file(), null); return j && j.v === 1 && j.notes && typeof j.notes === 'object' ? j.notes : {}; };
  return {
    save(id, note) {
      const all = read();
      all[lower(id)] = { note: String(note).slice(0, 4000), at: iso(now()) };
      const keep = Object.entries(all).sort((a, b) => (a[1].at < b[1].at ? 1 : -1)).slice(0, NOTES_MAX);
      C.writeState(file(), { v: 1, notes: Object.fromEntries(keep) });
    },
    get(id) { const n = read()[lower(id)]; return n && typeof n.note === 'string' ? n.note : null; },
    drop(id) {
      const all = read();
      if (!all[lower(id)]) return false;
      delete all[lower(id)];
      C.writeState(file(), { v: 1, notes: all });
      return true;
    },
  };
}

module.exports = { createCarry, notesStore, CarryError, TOOLS, PIECE, KEEP_SNAPSHOTS };
