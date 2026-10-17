// clone-workspace.js: "Clone workspace to this machine" (Henry, 2026-10-17: once a main computer is picked, chats never
// move between computers; this is the one way to take work elsewhere). This machine gets its OWN copy of a workspace:
// the repo (a checkout here), the unfinished work the other computer left in it, and its conversations as NEW
// conversations owned by this machine. The other computer keeps its originals, and so does this machine's synced
// copy of them: nothing of theirs is written, moved or removed.
//
//   createWorkspaceCloner({ dataDir, log, now, home, cap, cloner, roots, chats, carry, unpack, online, trust, rename,
//                           rescan, waitMs, pollMs })
//     -> { start(repo), job(id), forRepo(repo), idle() }
//
//   cloner    sync-clone.js's cloner: clone([origin]) and job(id), for a repo this machine has no checkout of
//   roots()   -> [folder]: the repos Fleet View lists here (an existing checkout of the origin is found among them)
//   chats(root) -> [{ id, file, account, name, renamed, last, device, deviceName }]: the conversations of that workspace
//             another computer owns, as this machine's synced copies have them (fleet-view.js: the session map, less the
//             removed ones); file is the synced copy's log
//   carry()   -> sync-carry.js's object while sync runs, else null: newestSnapshot(id, device), fetchPack(id, ref)
//   unpack(manifest, blobs, { root }) -> sync-work.js unpack's result (the default)
//   online(device) -> true | false | null: the other computer's link, for the notes
//   trust(cwd, account): Claude Code's trust question answered for the folder a copy resumes in (fleet-view.js trustMoved)
//   rename(id, name): the copy takes the original's Fleet View name (only one Henry gave it)
//   rescan(): the materializer scans now (after a clone, so the chats come down)
//
// start(repo): repo is a workspace folder here (its checkout is used as it is), or an origin (https://<host>/<path>):
// a checkout of it among roots() is used, else it is cloned the way "Clone what's missing" clones (sync-clone.js:
// its folder, its sign-in rules, its install), and the job waits (waitMs, 3 minutes) for its chats to come down.
// A checkout is never changed: work goes in a worktree of its own. One job per repo at a time (a second start gives
// the one under way). -> the job: { id, at, repo: { origin, name, root }, phase: 'checkout' | 'waiting' | 'work' |
// 'chats' | 'done' | 'failed', done, checkout: { state: 'here' | 'cloning' | 'cloned' | 'failed', dir, message },
// work: [{ name, branch, state: 'done' | 'failed', cwd, message }], chats: { total, picked, copied: [{ from, id, name,
// cwd }], already, failed: [{ from, name, message }] }, notes: [text], message }, kept 30 minutes after it ends.
//
// The work: for each conversation picked, the newest snapshot its computer left of its work (sync-carry.js: a portable
// chat's branch, its unpushed commits, staged and unstaged changes and new files, at the end of every turn and every 2
// minutes mid-turn), one per distinct piece of work, newest first, laid down with sync-work.js unpack into a worktree
// of this machine's checkout (a dirty checkout is never touched). That chat's copy resumes there. A chat with no
// snapshot, a snapshot with nothing in it, or one that fails is a note, never a stop. Env files are not copied (they
// travel only over the link when a chat moves): a note names them.
//
// The conversations: the newest `cap` (20) of the workspace's, by their last activity. Each is copied, per
// docs/sync-move-recipe.md's layout, into <the same projects folder>/<slug of the folder it resumes in>/<new id>.jsonl:
// a new random id, every record's sessionId (and session_id, so it is no fork of the original) made the new id, every
// record's cwd made the folder it resumes in (its work's worktree, else the folder the synced copy was laid down for,
// else the checkout's top), and its side folder (<id>/subagents, tool-results, workflows) copied the same way. Written
// to .part, then renamed, side folder first, the log last; its modified time is the original's. Its title lines are
// copied as they are, so it keeps its name. Once on disk it is this machine's own: the uploader sends it up as this
// machine's, as any conversation started here. <dataDir>/sync/workspace-clones.json remembers each copy ({ <new id>:
// { from, at, origin, file } }), so a second clone of the workspace copies only what has no copy yet.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const P = require(path.join(__dirname, 'platform.js'));
const C = require(path.join(__dirname, 'sync-common.js'));
const K = require(path.join(__dirname, 'sync-clone.js'));

const CAP = 20; // conversations one clone copies at most (the newest)
const WAIT_MS = 3 * 60e3; // after a clone, how long the job waits for the workspace's chats to come down
const POLL_MS = 3000;
const JOB_KEEP_MS = 30 * 60e3;
const REG_MAX = 2000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SIDE_MAX = 5000; // files in one side folder at most

const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const there = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };
const fold = (p) => P.foldCase(path.resolve(p));
const lower = (s) => String(s || '').toLowerCase();
const clip = (s, n = 300) => { const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const plural = (k, one, many) => `${k} ${k === 1 ? one : many}`;
const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); if (t.unref) t.unref(); });
const bad = (message) => Object.assign(new Error(message), { code: 'bad_request' });
const under = (base, p) => { const b = fold(base), x = fold(p); return x === b || x.startsWith(b + path.sep); };
function ago(ms, t) {
  const s = Math.max(0, Math.round((t - ms) / 1000));
  return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`;
}

// ---------- the log, rewritten for its new id and folder ----------
// text: a whole log. Every line that is a record gets sessionId and session_id (when they are the old id) made the new
// id, and cwd (when it has one) made the folder it resumes in; any other line stays as it is. A last line cut off
// (its writer ended mid-line) is left out, as the uploader leaves it.
function rewriteLog(text, from, to, cwd) {
  if (!UUID_RE.test(String(from)) || !UUID_RE.test(String(to))) throw new Error('not a conversation id');
  const old = lower(from);
  const hit =new RegExp(`${old}|"cwd"`, 'i');
  const parts = String(text).split('\n');
  const tail = parts.pop(); // '' when the text ends in a newline
  const out = [];
  const one = (line) => {
    if (!line.trim() || !hit.test(line)) return line;
    let d;
    try { d = JSON.parse(line); } catch { return line; }
    if (!d || typeof d !== 'object' || Array.isArray(d)) return line;
    let changed = false;
    if (typeof d.sessionId === 'string' && lower(d.sessionId) === old) { d.sessionId = to; changed = true; }
    if (typeof d.session_id === 'string' && lower(d.session_id) === old) { d.session_id = to; changed = true; }
    if (typeof d.cwd === 'string' && d.cwd !== cwd) { d.cwd = cwd; changed = true; }
    return changed ? JSON.stringify(d) : line;
  };
  for (const line of parts) out.push(one(line.endsWith('\r') ? line.slice(0, -1) : line) + (line.endsWith('\r') ? '\r' : ''));
  let res = out.length ? `${out.join('\n')}\n` : '';
  if (tail) { try { JSON.parse(tail); res += one(tail); } catch {} }
  return res;
}

// the files under a side folder (no links followed) -> [rel with path.sep], at most SIDE_MAX
function sideFiles(dir) {
  const out = [];
  const walk = (abs, rel) => {
    let ents = [];
    try { ents = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (out.length >= SIDE_MAX) return;
      const r = rel ? path.join(rel, e.name) : e.name;
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) walk(path.join(abs, e.name), r);
      else if (e.isFile()) out.push(r);
    }
  };
  walk(dir, '');
  return out;
}
const writeAtomic = (file, data) => {
  const part = `${file}.part`;
  fs.writeFileSync(part, data);
  fs.renameSync(part, file);
};
// One conversation copied as a new one: src (its log), from (its id), to (the new id), cwd (the folder the copy resumes
// in). Into the same projects folder, the slug folder of cwd. -> { file, dir }. Throws, leaving nothing, when the
// copy can't be made; the source is only read.
function copyConversation({ src, from, to, cwd }) {
  if (!UUID_RE.test(from) || !UUID_RE.test(to)) throw new Error('not a conversation id');
  const srcDir = path.dirname(path.resolve(src));
  const projects = path.dirname(srcDir);
  const dir = path.join(projects, C.slugOf(cwd));
  if (!under(projects, dir) || fold(dir) === fold(projects)) throw new Error('its folder would be outside the projects folder');
  const file = path.join(dir, `${to}.jsonl`), side = path.join(dir, to);
  if (there(file) || there(side)) throw new Error('a conversation with that id is there already');
  const st = fs.statSync(src);
  const text = fs.readFileSync(src, 'utf8');
  fs.mkdirSync(dir, { recursive: true });
  if (fs.lstatSync(dir).isSymbolicLink()) throw new Error('its slug folder is a link');
  try {
    const fromSide = path.join(srcDir, from);
    if (isDir(fromSide) && !fs.lstatSync(fromSide).isSymbolicLink()) {
      for (const rel of sideFiles(fromSide)) {
        const a = path.join(fromSide, rel), b = path.join(side, rel);
        fs.mkdirSync(path.dirname(b), { recursive: true });
        const st2 = fs.statSync(a);
        if (/\.jsonl$/i.test(rel)) writeAtomic(b, rewriteLog(fs.readFileSync(a, 'utf8'), from, to, cwd));
        else if (/\.meta\.json$/i.test(rel)) writeAtomic(b, fs.readFileSync(a)); // a subagent's meta: no id in it
        else { fs.copyFileSync(a, `${b}.part`); fs.renameSync(`${b}.part`, b); }
        try { fs.utimesSync(b, st2.atime, st2.mtime); } catch {}
      }
    }
    writeAtomic(file, rewriteLog(text, from, to, cwd));
    try { fs.utimesSync(file, st.atime, st.mtime); } catch {}
  } catch (e) {
    try { fs.rmSync(file, { force: true }); } catch {}
    try { fs.rmSync(`${file}.part`, { force: true }); } catch {}
    try { fs.rmSync(side, { recursive: true, force: true }); } catch {}
    throw e;
  }
  return { file, dir };
}

// The folder a chat's copy resumes in when its work brought no worktree: the folder this machine's synced copy was laid
// down for (the slug folder it is in: the checkout's top, or the folder its rel_cwd names when that is here, as the
// materializer picks it), else the checkout's top.
function folderFor(chat, root) {
  const slug = path.basename(path.dirname(path.resolve(chat.file)));
  if (C.slugOf(root) === slug) return root;
  const cands = [];
  const cwd = (() => { try { return C.lastMeta(chat.file).cwd; } catch { return null; } })();
  if (typeof cwd === 'string' && cwd) {
    const segs = cwd.split(/[\\/]+/).filter(Boolean);
    const wt = segs.findIndex((s, i) => s === '.claude' && segs[i + 1] === 'worktrees');
    const at = wt >= 0 ? wt : segs.map(lower).lastIndexOf(lower(path.basename(root))) + 1;
    if (at > 0 && at < segs.length) cands.push(path.join(root, ...segs.slice(at)));
  }
  const wtDir = path.join(root, '.claude', 'worktrees');
  try { for (const n of fs.readdirSync(wtDir)) cands.push(path.join(wtDir, n)); } catch {}
  return cands.find((d) => C.slugOf(d) === slug && isDir(d)) || root;
}

// the same piece of work, whichever chat's snapshot it came in
const workKey = (m) => [m.origin, m.worktree || '', m.branch || '', m.head || '', m.bundle || '', m.staged || '', m.unstaged || '',
  (Array.isArray(m.untracked) ? m.untracked : []).map((e) => `${e.path}:${e.sha256}`).sort().join(',')].join('|');
const emptyWork = (snap) => !!snap && !!snap.summary && !Number(snap.summary.commits) && !Number(snap.summary.files);

function createWorkspaceCloner(o = {}) {
  const dataDir = o.dataDir || P.dataDir();
  const now = typeof o.now === 'function' ? o.now : Date.now;
  const log = typeof o.log === 'function' ? o.log : () => {};
  const cap = Number.isSafeInteger(o.cap) && o.cap > 0 ? o.cap : CAP;
  const waitMs = Number.isFinite(o.waitMs) ? o.waitMs : WAIT_MS;
  const pollMs = Number.isFinite(o.pollMs) ? o.pollMs : POLL_MS;
  const roots = typeof o.roots === 'function' ? o.roots : () => [];
  const chatsOf = typeof o.chats === 'function' ? o.chats : () => [];
  const carryOf = typeof o.carry === 'function' ? o.carry : () => null;
  const unpack = typeof o.unpack === 'function' ? o.unpack : (m, b, x) => require(path.join(__dirname, 'sync-work.js')).unpack(m, b, { home: o.home || os.homedir(), ...x });
  const online = typeof o.online === 'function' ? o.online : () => null;
  const trust = typeof o.trust === 'function' ? o.trust : () => false;
  const rename = typeof o.rename === 'function' ? o.rename : () => {};
  const rescan = typeof o.rescan === 'function' ? o.rescan : () => {};
  const cloner = o.cloner || null;
  const regFile = path.join(dataDir, 'sync', 'workspace-clones.json');

  // ---------- the copies made ----------
  function readReg() {
    const j = C.readState(regFile, null);
    const copies = j && j.copies && typeof j.copies === 'object' && !Array.isArray(j.copies) ? j.copies : {};
    const out = {};
    for (const [id, v] of Object.entries(copies)) if (UUID_RE.test(id) && v && UUID_RE.test(String(v.from)) && typeof v.file === 'string') out[lower(id)] = { from: lower(v.from), at: Number(v.at) || 0, origin: v.origin || null, file: v.file };
    return out;
  }
  function addReg(id, v) {
    const copies = readReg();
    copies[id] = v;
    const keep = Object.entries(copies).sort((a, b) => a[1].at - b[1].at).slice(-REG_MAX);
    try { C.writeState(regFile, { v: 1, copies: Object.fromEntries(keep) }); } catch (e) { log(`clone-workspace: could not save ${regFile}: ${e.message}`); }
  }
  // from (an original's id) -> the copy of it still on disk, or null
  const copyOf = (reg, from) => Object.entries(reg).find(([, v]) => v.from === from && there(v.file)) || null;

  // ---------- jobs ----------
  const jobs = new Map(); // id -> job
  const byRepo = new Map(); // folded root or origin -> job id of the one under way
  const running = new Set();
  const idleWaiters = [];
  const settle = () => { if (!running.size) while (idleWaiters.length) idleWaiters.shift()(); };
  const idle = () => new Promise((r) => { idleWaiters.push(r); settle(); });
  const copy = (j) => (j ? JSON.parse(JSON.stringify({ ...j, endedAt: undefined, keys: undefined })) : null);
  function prune() {
    for (const [id, j] of jobs) if (j.done && now() - j.endedAt > JOB_KEEP_MS) jobs.delete(id);
  }

  // repo -> { root, origin, name } of a checkout here, or { origin } when there is none (throws bad_request)
  async function resolve(repo) {
    if (typeof repo !== 'string' || !repo.trim() || repo.length > 1000) throw bad('give the workspace: its folder, or its repo');
    const r0 = repo.trim();
    if (path.isAbsolute(r0)) {
      const r = await C.repoOf(r0, { fresh: true }).catch(() => null);
      if (!r) throw bad(`${r0} is not a git checkout`);
      if (!r.origin) throw bad(`${path.basename(r.mainRoot)} has no origin to clone it by`);
      return { root: r.mainRoot, origin: r.origin, name: path.basename(r.mainRoot) };
    }
    const origin = C.normalizeOrigin(r0);
    if (!origin || !K.cloneable(origin)) throw bad('give the workspace: its folder, or its repo');
    let list = [];
    try { list = roots() || []; } catch {}
    for (const f of Array.isArray(list) ? list : []) {
      if (typeof f !== 'string' || !path.isAbsolute(f)) continue;
      const r = await C.repoOf(f).catch(() => null);
      if (r && r.origin === origin) return { root: r.mainRoot, origin, name: path.basename(r.mainRoot) };
    }
    return { root: null, origin, name: K.nameOf(origin) };
  }

  async function start(repo) {
    prune();
    const r = await resolve(repo);
    const k = r.root ? fold(r.root) : r.origin;
    const had = byRepo.get(k) || byRepo.get(r.origin);
    if (had && jobs.get(had) && !jobs.get(had).done) return copy(jobs.get(had));
    const job = {
      id: crypto.randomBytes(8).toString('hex'), at: new Date(now()).toISOString(), repo: { origin: r.origin, name: r.name, root: r.root },
      phase: 'checkout', done: false, endedAt: 0,
      checkout: r.root ? { state: 'here', dir: r.root, message: `uses the checkout here: ${r.root}` } : { state: 'cloning', dir: null, message: 'cloning it here' },
      work: [], chats: { total: 0, picked: 0, copied: [], already: 0, failed: [] }, notes: [], message: '',
    };
    jobs.set(job.id, job);
    byRepo.set(k, job.id);
    if (r.root) byRepo.set(r.origin, job.id);
    running.add(job.id);
    run(job).catch((e) => {
      job.phase = 'failed';
      job.message = clip((e && e.message) || e);
      log(`clone-workspace: ${job.repo.name}: ${job.message}`);
    }).finally(() => {
      job.done = true;
      job.endedAt = now();
      if (job.phase !== 'failed') job.phase = 'done';
      running.delete(job.id);
      for (const [kk, id] of byRepo) if (id === job.id) byRepo.delete(kk);
      settle();
    });
    return copy(job);
  }

  // the checkout: cloned (sync-clone.js) when this machine has none, then its chats waited for
  async function checkout(job) {
    if (job.repo.root) return job.repo.root;
    if (!cloner) throw new Error('this machine can\'t clone repos (sync is not running)');
    const c = await cloner.clone([job.repo.origin]);
    let item = null;
    if (c && c.job) {
      for (;;) {
        const j = cloner.job(c.job.id);
        item = j && j.items.find((x) => x.origin === job.repo.origin);
        if (!j || j.done) break;
        await sleep(pollMs);
      }
    }
    if (!item || !['done', 'found'].includes(item.state) || !item.dir) {
      job.checkout = { state: 'failed', dir: null, message: (item && item.message) || 'it is being cloned already: try again once that is done' };
      throw new Error(job.checkout.message);
    }
    job.checkout = { state: 'cloned', dir: item.dir, message: item.message || `cloned to ${item.dir}` };
    job.repo.root = item.dir;
    // its chats come down with the materializer's next scan
    job.phase = 'waiting';
    try { rescan(); } catch {}
    for (const end = now() + waitMs; now() < end;) {
      if (listChats(item.dir).length) break;
      await sleep(pollMs);
    }
    return item.dir;
  }
  function listChats(root) {
    let list = [];
    try { list = chatsOf(root) || []; } catch {}
    return (Array.isArray(list) ? list : []).filter((c) => c && UUID_RE.test(String(c.id)) && typeof c.file === 'string' && there(c.file))
      .map((c) => ({ ...c, id: lower(c.id) })).sort((a, b) => (Number(b.last) || 0) - (Number(a.last) || 0));
  }

  async function run(job) {
    const root = await checkout(job);
    const all = listChats(root);
    const picked = all.slice(0, cap);
    job.chats.total = all.length;
    job.chats.picked = picked.length;
    if (!all.length) {
      job.notes.push(`${job.repo.name} has no chats from another computer here${job.checkout.state === 'cloned' ? ' yet: they come down with the next sync round, then clone it again' : ''}`);
      return;
    }
    if (all.length > picked.length) job.notes.push(`copies the newest ${picked.length} of its ${all.length} chats`);
    const reg = readReg();
    const todo = picked.filter((c) => { const had = copyOf(reg, c.id); if (had) job.chats.already++; return !had; });
    const folders = await work(job, todo, root);
    job.phase = 'chats';
    for (const chat of todo) {
      const id = crypto.randomUUID();
      const cwd = folders.get(chat.id) || folderFor(chat, root);
      try {
        const out = copyConversation({ src: chat.file, from: chat.id, to: id, cwd });
        addReg(id, { from: chat.id, at: now(), origin: job.repo.origin, file: out.file });
        try { trust(cwd, chat.account); } catch {}
        if (chat.renamed && chat.name) { try { rename(id, chat.name); } catch {} }
        job.chats.copied.push({ from: chat.id, id, name: chat.name || chat.id.slice(0, 8), cwd });
      } catch (e) {
        job.chats.failed.push({ from: chat.id, name: chat.name || chat.id.slice(0, 8), message: clip((e && e.message) || e, 200) });
      }
    }
    log(`clone-workspace: ${job.repo.name}: copied ${plural(job.chats.copied.length, 'chat', 'chats')} to this machine${job.chats.failed.length ? `, ${job.chats.failed.length} failed` : ''}${job.chats.already ? `, ${job.chats.already} copied before` : ''}`);
  }

  // the work the other computer left in these chats -> Map chat id -> the folder its copy resumes in
  async function work(job, todo, root) {
    const folders = new Map();
    if (!todo.length) return folders;
    job.phase = 'work';
    const carry = (() => { try { return carryOf(); } catch { return null; } })();
    const devices = new Map(todo.filter((c) => c.device).map((c) => [lower(c.device), c.deviceName || 'the other computer']));
    const away = [...devices.values()].join(' and ') || 'the other computer';
    if (!carry) { job.notes.push(`unpushed work on ${away} not copied: sync is not running here`); return folders; }
    for (const [dev, name] of devices) if (online(dev) === false) job.notes.push(`${name} is offline: its work comes from the last snapshot it left`);
    const snaps = [];
    let none = 0;
    for (const chat of todo) {
      if (!chat.device) continue;
      let snap = null;
      try { snap = await carry.newestSnapshot(chat.id, lower(chat.device)); } catch (e) { job.notes.push(`${chat.name || chat.id.slice(0, 8)}: its work's snapshots could not be read (${clip(e && e.message, 120)})`); continue; }
      if (!snap) none++;
      else if (!emptyWork(snap)) snaps.push({ chat, snap });
    }
    if (none) job.notes.push(`${plural(none, 'chat left', 'chats left')} no snapshot of its work: anything unpushed in ${none === 1 ? 'it' : 'them'} stays on ${away}`);
    snaps.sort((a, b) => (a.snap.at < b.snap.at ? 1 : -1));
    const done = new Map(); // workKey -> { into, name }
    const env = new Set();
    for (const { chat, snap } of snaps) {
      const name = chat.name || chat.id.slice(0, 8);
      let got;
      try { got = await carry.fetchPack(chat.id, snap); } catch (e) {
        job.work.push({ name, branch: null, state: 'failed', cwd: null, message: `its work could not be downloaded: ${clip(e && e.message, 160)}` });
        continue;
      }
      const m = got.manifest || {};
      if (m.kind !== 'git' || m.origin !== job.repo.origin) continue;
      for (const e of Array.isArray(m.env) ? m.env : []) env.add(e);
      const rel = String(m.rel || '').split('/').filter(Boolean);
      const key = workKey(m);
      const same = done.get(key);
      if (same) {
        const d = path.join(same.into, ...rel);
        folders.set(chat.id, isDir(d) ? d : same.into);
        continue;
      }
      try {
        const res = await unpack(m, got.blobs, { root });
        done.set(key, { into: res.into, name });
        folders.set(chat.id, res.cwd || res.into);
        const s = m.summary || {};
        const what = [s.commits ? plural(s.commits, 'commit', 'commits') : '', s.files ? plural(s.files, 'file', 'files') : ''].filter(Boolean).join(', ');
        job.work.push({ name, branch: res.branch || m.branch || null, state: 'done', cwd: res.cwd || res.into,
          message: `${what || 'its work'}${m.branch ? ` on ${m.branch}` : ''}, as of ${ago(Date.parse(snap.at) || now(), now())}, in ${res.into}` });
        for (const n of (res.notes || []).slice(0, 3)) job.notes.push(`${name}: ${clip(n, 200)}`);
      } catch (e) {
        job.work.push({ name, branch: m.branch || null, state: 'failed', cwd: null, message: `its work could not be laid down here: ${clip(e && e.message, 200)}` });
      }
    }
    if (env.size) job.notes.push(`env files not copied (they travel only when a chat moves): ${[...env].slice(0, 6).join(', ')}${env.size > 6 ? '…' : ''}`);
    return folders;
  }

  const job = (id) => copy(typeof id === 'string' ? jobs.get(id) : null);
  // the newest job for a workspace folder or origin, or null
  function forRepo(repo) {
    if (typeof repo !== 'string' || !repo) return null;
    const k = path.isAbsolute(repo) ? fold(repo) : C.normalizeOrigin(repo);
    const list = [...jobs.values()].filter((j) => (j.repo.root && fold(j.repo.root) === k) || j.repo.origin === k).sort((a, b) => (a.at < b.at ? 1 : -1));
    return copy(list[0] || null);
  }
  return { start, job, forRepo, idle };
}

module.exports = { createWorkspaceCloner, rewriteLog, copyConversation, folderFor, CAP };
