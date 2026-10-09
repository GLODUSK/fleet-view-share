// Changes tab: what the conversation changed in its repo, as a diff you can comment on line by line and send back
// to Claude in one message, like the Claude desktop app's review pane. The server side is changes.js (GET /changes).
//
// detail.js calls renderChangesPane(pane, s, opts) about once a second while the tab shows. The first call builds
// the pane; every call is cheap. While the tab shows, it asks GET /changes every POLL_MS (with ?since=<sig>, so an
// unchanged answer is a few bytes) and stops when the calls stop (STALE_MS). Refresh asks at once, past the
// server's short cache. Only what changed is redrawn: a file whose JSON is the same keeps its rows, and the scroll
// position, which files are open, the comments and any half-typed comment all stay put.
//
// Top bar: "Uncommitted | Whole branch" (base=work: the working tree against HEAD with untracked files; base=branch:
// everything since the branch left main), the file count and total +/-, and Refresh. Then one row per file (status
// letter, the path with its folder dim, +n -n, Open in VS Code at the first changed line); a click opens its diff,
// drawn only then: both line numbers, red/green rows in chat.css's edit-diff colours, hunk headers, and syntax
// highlighting (highlight.js, the same vendored copy chat.js loads) filled in a little at a time.
//
// Comments: click a line (or the + in its gutter) to open a box under it; Enter saves, Shift+Enter is a new line,
// Esc cancels. A comment shows under its line with Edit and Delete. With an open diff focused, the arrow keys move a
// line cursor and Enter (or c) comments on that line. The footer counts the comments; "Send to Claude" turns them
// into one message ("Review comments on your changes (uncommitted): 1. path:42 (+) > the line / your comment ...")
// and hands it to the chat box, sent at once (handto.js), then clears them. Comments are kept per conversation
// while the page lives and in localStorage (fv.review.<id>), so a reload keeps them; a comment whose line has left
// the diff shows at the end of its file (or below the list when the file left it) and is still sent.
import { esc, revealLink } from './cards.js';
import { icon } from './icons.js';
import { handToChat } from './handto.js';

const POLL_MS = 3000;
const STALE_MS = 3000; // no renderChangesPane call for this long: the tab is hidden, stop asking
const HL_LINES = 3000; // lines highlighted per file at most
const HL_CHUNK = 150; // lines highlighted per idle slice
const CODE_CAP = 240; // characters of a line quoted in the message

// ---------- per conversation: comments, the base, open files, unsent drafts ----------
const convos = new Map(); // id -> { comments: [], base, open: Set<path>, edits: Map<editKey, { path, k, cid, draft }> }
function convo(id) {
  let v = convos.get(id);
  if (v) return v;
  v = { comments: [], base: 'work', open: new Set(), edits: new Map() };
  try {
    const j = JSON.parse(localStorage.getItem('fv.review.' + id) || 'null');
    if (j && Array.isArray(j.comments)) v.comments = j.comments.filter((m) => m && m.path && m.k && typeof m.text === 'string');
    if (j && (j.base === 'work' || j.base === 'branch')) v.base = j.base;
  } catch {}
  convos.set(id, v);
  return v;
}
function save(id) {
  const v = convos.get(id);
  if (!v) return;
  try {
    if (!v.comments.length && v.base === 'work') localStorage.removeItem('fv.review.' + id);
    else localStorage.setItem('fv.review.' + id, JSON.stringify({ comments: v.comments, base: v.base }));
  } catch {}
}
const editKey = (path, k, cid) => `${path}\n${k}\n${cid || 'new'}`;

// ---------- highlight.js: vendored, loaded the first time a diff opens ----------
const LANG_OF = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', jsonc: 'json', sh: 'bash', bash: 'bash', zsh: 'bash', ps1: 'powershell', psm1: 'powershell', py: 'python', css: 'css',
  html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', vue: 'xml', md: 'markdown', sql: 'sql', yml: 'yaml', yaml: 'yaml', diff: 'diff', patch: 'diff',
};
const langOf = (p) => LANG_OF[(/\.([^./]+)$/.exec(p) || [])[1]?.toLowerCase()] || null;
let hlP = null;
const hlLangs = new Map(); // language -> Promise
function hljsFor(lang) {
  if (!hlP) {
    hlP = import('./vendor/highlight/core.min.js').then((m) => m.default);
    hlP.catch(() => { hlP = null; });
  }
  return hlP.then((hljs) => {
    if (hljs.getLanguage(lang)) return hljs;
    if (!hlLangs.has(lang)) {
      const p = import(`./vendor/highlight/languages/${lang}.min.js`).then((m) => { hljs.registerLanguage(lang, m.default); });
      p.catch(() => hlLangs.delete(lang));
      hlLangs.set(lang, p);
    }
    return hlLangs.get(lang).then(() => hljs);
  });
}
const idle = (fn) => (window.requestIdleCallback ? requestIdleCallback(fn, { timeout: 300 }) : setTimeout(fn, 16));

// ---------- small pieces ----------
const STATUS = { M: ['M', 'mod', 'modified'], A: ['A', 'add', 'added'], D: ['D', 'del', 'deleted'], R: ['R', 'ren', 'renamed'], '?': ['U', 'new', 'untracked (new, not added to git yet)'] };
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const splitPath = (p) => { const i = p.lastIndexOf('/'); return i < 0 ? ['', p] : [p.slice(0, i + 1), p.slice(i + 1)]; };
function absOf(root, rel) {
  if (!root || !rel) return null;
  const sep = root.includes('\\') ? '\\' : '/';
  return root.replace(/[\\/]+$/, '') + sep + rel.split('/').join(sep);
}
const lineKey = (row) => (row.t === '-' ? 'a' + row.a : 'b' + row.b);
const lineNo = (k) => parseInt(k.slice(1), 10) || 0;
function firstLine(f) {
  for (const h of f.hunks || []) for (const r of h.lines) if (r.t !== ' ' && r.b) return r.b;
  return f.hunks?.[0]?.lines?.find((r) => r.b)?.b || 0;
}

// ---------- the pane ----------
function buildPane(pane) {
  pane.innerHTML = `
<div class="chg-pane">
  <div class="chg-bar">
    <div class="chg-seg" role="group" aria-label="compare with">
      <button type="button" data-base="work" aria-pressed="true" title="What a commit would take now: staged, unstaged and new files">Uncommitted</button>
      <button type="button" data-base="branch" aria-pressed="false" title="Everything since this branch left main: its commits and what is uncommitted">Whole branch</button>
    </div>
    <span class="chg-sum"></span>
    <span class="grow"></span>
    <button type="button" class="chg-refresh" data-refresh title="Read the changes again now (they also refresh every few seconds)">Refresh</button>
  </div>
  <div class="chg-scroll">
    <div class="chg-state" hidden></div>
    <div class="chg-list"></div>
    <div class="chg-orphans" hidden></div>
  </div>
  <div class="chg-foot">
    <span class="chg-count"></span>
    <span class="grow"></span>
    <button type="button" class="btn chg-clear" data-clear hidden>Clear</button>
    <button type="button" class="btn primary chg-send" data-send disabled>Send to Claude</button>
  </div>
</div>`;
  const root = pane.firstElementChild;
  const c = {
    pane, root,
    seg: [...root.querySelectorAll('[data-base]')], sum: root.querySelector('.chg-sum'), refreshBtn: root.querySelector('[data-refresh]'),
    scroll: root.querySelector('.chg-scroll'), state: root.querySelector('.chg-state'), list: root.querySelector('.chg-list'),
    orphans: root.querySelector('.chg-orphans'), count: root.querySelector('.chg-count'), clearBtn: root.querySelector('[data-clear]'),
    sendBtn: root.querySelector('[data-send]'),
    id: null, cwd: null, v: null, data: null, sig: '', error: '',
    fileEls: new Map(), // path -> element (el._f the file, el._json its JSON)
    edNodes: new Map(), // editKey -> editor element, reused across redraws so drafts and focus survive
    gen: 0, busy: false, again: false, looping: false, seen: 0, clearArm: 0, stateHtml: null,
  };
  pane._chg = c;
  root.addEventListener('click', (e) => onClick(c, e));
  root.addEventListener('keydown', (e) => onKey(c, e));
  root.addEventListener('input', (e) => {
    const ed = e.target.closest?.('.cn-ed');
    if (!ed || !c.v) return;
    const w = c.v.edits.get(ed.dataset.ed);
    if (w) w.draft = e.target.value;
    grow(e.target);
  });
  return c;
}

function reset(c, s, cwd) {
  c.gen++;
  c.id = s.id;
  c.cwd = cwd;
  c.v = convo(s.id);
  c.data = null; c.sig = ''; c.error = ''; c.busy = false; c.again = false;
  c.fileEls.clear(); c.edNodes.clear();
  c.list.textContent = '';
  c.scroll.scrollTop = 0;
  drawBar(c);
  drawOrphans(c);
  drawFoot(c);
  drawState(c);
}

export function renderChangesPane(pane, s, opts = {}) {
  if (!s || !s.id) return;
  const c = pane._chg || buildPane(pane);
  const cwd = s.cwd || s.links?.repoFolder || null;
  if (c.id !== s.id || c.cwd !== cwd) reset(c, s, cwd);
  c.seen = Date.now();
  loop(c);
}

// ---------- asking the server ----------
async function loop(c) {
  if (c.looping) return;
  c.looping = true;
  try {
    while (c.pane.isConnected && Date.now() - c.seen < STALE_MS) {
      await load(c, false);
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  } finally { c.looping = false; }
}

async function load(c, fresh) {
  if (!c.cwd) { drawState(c); return; }
  if (c.busy) { if (fresh) c.again = true; return; }
  c.busy = true;
  const gen = c.gen, base = c.v.base;
  drawState(c);
  try {
    const q = `cwd=${encodeURIComponent(c.cwd)}&base=${base}${c.sig && !fresh ? `&since=${encodeURIComponent(c.sig)}` : ''}${fresh ? '&fresh=1' : ''}`;
    const r = await fetch(`/changes?${q}`, { cache: 'no-store' });
    const j = await r.json().catch(() => null);
    if (gen !== c.gen || base !== c.v.base) return;
    if (!j) c.error = `Couldn't read the changes (${r.status})`;
    else if (!j.ok) c.error = j.message || `Couldn't read the changes (${r.status})`;
    else {
      c.error = '';
      if (!j.same) { c.data = j; c.sig = j.sig || ''; drawList(c); }
    }
  } catch (e) {
    if (gen === c.gen) c.error = "Couldn't reach Fleet View";
  } finally {
    if (gen === c.gen) {
      c.busy = false;
      drawBar(c); drawState(c);
      if (c.again) { c.again = false; load(c, true); }
    }
  }
}

// ---------- drawing ----------
function drawBar(c) {
  const base = c.v?.base || 'work';
  for (const b of c.seg) b.setAttribute('aria-pressed', String(b.dataset.base === base));
  const d = c.data;
  let html = '';
  if (d && d.files?.length) {
    let add = 0, del = 0;
    for (const f of d.files) { add += f.added || 0; del += f.removed || 0; }
    html = `<span class="chg-n">${plural(d.files.length, 'file')}</span><span class="d-add">+${add}</span><span class="d-del">−${del}</span>`;
  }
  if (d && d.branch) {
    const vs = d.base === 'branch' && d.baseRef ? ` vs ${d.baseRef}` : '';
    html += `<span class="chg-br" title="${esc(d.root || '')}">${icon('branch', 12)}<span>${esc(d.branch + vs)}</span></span>`;
  }
  if (c.sumHtml !== html) { c.sum.innerHTML = html; c.sumHtml = html; }
  c.refreshBtn.classList.toggle('busy', !!c.busy);
}

function drawState(c) {
  const d = c.data;
  let html = '';
  if (!c.cwd) html = `<div class="chg-empty">${icon('folder', 16)}<span>This conversation has no folder to compare</span></div>`;
  else if (c.error && !d) html = `<div class="chg-empty">${icon('error', 16)}<span>${esc(c.error)}</span></div>`;
  else if (!d) html = '<div class="chg-empty faint"><span>Reading the changes…</span></div>';
  else if (d.note === 'not a git repo') html = `<div class="chg-empty">${icon('repo', 16)}<span>Not a git repo</span><span class="chg-sub">${esc(c.cwd)}</span></div>`;
  else {
    const notes = [];
    if (c.error) notes.push(`<div class="chg-line err">${icon('error', 12)}<span>${esc(c.error)}</span></div>`);
    if (d.note) notes.push(`<div class="chg-line">${icon('info', 12)}<span>${esc(d.note)}</span></div>`);
    if (d.truncated) notes.push(`<div class="chg-line">${icon('info', 12)}<span>A big change: some lines aren't shown. Open the file to see all of it.</span></div>`);
    if (!d.files.length) {
      const hint = d.base === 'branch' ? 'This branch has nothing that isn\'t on main' : 'Nothing uncommitted. "Whole branch" shows what the branch changed since main';
      notes.push(`<div class="chg-empty">${icon('check', 16)}<span>No changes</span><span class="chg-sub">${esc(hint)}</span></div>`);
    }
    html = notes.join('');
  }
  if (c.stateHtml !== html) { c.state.innerHTML = html; c.stateHtml = html; }
  c.state.hidden = !html;
}

function fileHead(c, f, open) {
  const [dir, name] = splitPath(f.path);
  const [letter, cls, word] = STATUS[f.status] || STATUS.M;
  const from = f.status === 'R' && f.old ? `<span class="chg-from" title="renamed from ${esc(f.old)}">← ${esc(f.old)}</span>` : '';
  const pm = f.binary ? '<span class="chg-bin">binary</span>' : `<span class="d-add">+${f.added || 0}</span><span class="d-del">−${f.removed || 0}</span>`;
  const abs = f.status === 'D' ? null : absOf(c.data?.root, f.path);
  const line = firstLine(f);
  let open$ = abs ? revealLink('file', abs, `${icon('open', 12)}<span>Open</span>`, `open in VS Code: ${abs}${line ? ':' + line : ''}`, 'chg-open') : '';
  if (open$ && line) open$ = open$.replace('<a ', `<a data-line="${line}" `);
  return `<button type="button" class="chg-fbtn" aria-expanded="${open}" title="${esc(f.path)}">`
    + `<span class="chg-chev">${icon('chevron', 12)}</span><span class="chg-st st-${cls}" title="${esc(word)}">${letter}</span>`
    + `<span class="chg-path"><span class="chg-dir">${esc(dir)}</span><span class="chg-name">${esc(name)}</span>${from}</span>`
    + `<span class="chg-ncm" hidden></span><span class="chg-pm">${pm}</span></button>${open$}`;
}

// the files, patched in place: unchanged ones keep their element (and their open diff); the view stays on the line
// it was on
function drawList(c) {
  const d = c.data;
  const files = d?.files || [];
  const anchor = takeAnchor(c);
  const seen = new Set();
  let i = 0;
  for (const f of files) {
    seen.add(f.path);
    const json = JSON.stringify(f) + '|' + (d.root || '');
    let el = c.fileEls.get(f.path);
    const open = c.v.open.has(f.path);
    if (!el) {
      el = document.createElement('div');
      el.className = 'chg-file';
      el.dataset.path = f.path;
      el.innerHTML = '<div class="chg-frow"></div><div class="chg-diff" tabindex="0" hidden></div>';
      el._row = el.firstElementChild;
      el._diff = el.lastElementChild;
      c.fileEls.set(f.path, el);
    }
    if (el._json !== json) {
      el._f = f;
      el._json = json;
      el._row.innerHTML = fileHead(c, f, open);
      el.classList.toggle('open', open);
      el._diff.hidden = !open;
      if (open) drawDiff(c, el); else { el._diff.textContent = ''; el._drawn = false; }
    }
    drawBadge(c, el);
    const at = c.list.children[i];
    if (at !== el) c.list.insertBefore(el, at || null);
    i++;
  }
  for (const [p, el] of c.fileEls) if (!seen.has(p)) { el.remove(); c.fileEls.delete(p); }
  drawOrphans(c);
  drawFoot(c);
  drawBar(c);
  putAnchor(c, anchor);
}

// what sits at the top of the list (a line, or a file row), and how far down, so a redraw can keep it there
function takeAnchor(c) {
  const box = c.scroll.getBoundingClientRect();
  if (!box.height || c.scroll.scrollTop < 1) return null;
  const hit = document.elementFromPoint(box.left + Math.min(60, box.width / 2), box.top + 6);
  const line = hit?.closest?.('.cl[data-k]');
  const file = hit?.closest?.('.chg-file');
  if (!file || !c.scroll.contains(file)) return null;
  const el = line || file;
  return { path: file.dataset.path, k: line?.dataset.k || null, top: el.getBoundingClientRect().top - box.top };
}
function putAnchor(c, a) {
  if (!a) return;
  const file = c.fileEls.get(a.path);
  if (!file || !file.isConnected) return;
  const el = (a.k && file._diff.querySelector(`.cl[data-k="${a.k}"]`)) || file;
  const now = el.getBoundingClientRect().top - c.scroll.getBoundingClientRect().top;
  if (Math.abs(now - a.top) > 0.5) c.scroll.scrollTop += now - a.top;
}

function drawBadge(c, el) {
  const n = c.v.comments.filter((m) => m.path === el.dataset.path).length;
  const b = el._row.querySelector('.chg-ncm');
  if (!b) return;
  const html = n ? `${icon('reply', 11)}<span>${n}</span>` : '';
  if (b._html !== html) { b.innerHTML = html; b._html = html; b.title = n ? plural(n, 'comment') : ''; }
  b.hidden = !n;
}

// one file's diff, drawn when it opens (and again when its lines change)
function drawDiff(c, el) {
  const f = el._f;
  const focused = document.activeElement;
  const keepFocus = focused && el._diff.contains(focused) ? focused : null;
  const caret = keepFocus && keepFocus.tagName === 'TEXTAREA' ? [keepFocus.selectionStart, keepFocus.selectionEnd] : null;
  el._hl = (el._hl || 0) + 1;
  const lines = new Map(); // key -> { t, n, text }
  const out = [];
  if (f.binary) out.push('<div class="cl-note">Binary file, not shown</div>');
  else if (!f.hunks.length) out.push(`<div class="cl-note">${f.status === 'R' ? 'Renamed, no line changes' : f.truncated ? 'Too big to show here. Open the file to see it' : 'No line changes'}</div>`);
  for (const h of f.hunks) {
    out.push(`<div class="cl-hunk">${esc(h.header)}</div>`);
    for (const r of h.lines) {
      const k = lineKey(r);
      lines.set(k, { t: r.t, n: r.t === '-' ? r.a : r.b, text: r.text });
      const cls = r.t === '+' ? 'cl-add' : r.t === '-' ? 'cl-del' : 'cl-ctx';
      out.push(`<div class="cl ${cls}" data-k="${k}"><span class="cl-n">${r.a ?? ''}</span><span class="cl-n">${r.b ?? ''}</span>`
        + `<span class="cl-m">${r.t === '+' ? '+' : r.t === '-' ? '−' : ''}<button type="button" class="cl-plus" tabindex="-1" aria-label="Comment on this line" title="Comment on this line">+</button></span>`
        + `<span class="cl-t">${esc(r.text)}</span></div>`);
    }
  }
  if (f.truncated && f.hunks.length) out.push('<div class="cl-note">The rest of this file isn\'t shown. Open it to see all of it</div>');
  el._lines = lines;
  el._diff.innerHTML = out.join('');
  el._drawn = true;
  el._cur = null;
  drawNotes(c, el);
  if (keepFocus) {
    if (keepFocus.isConnected) { keepFocus.focus({ preventScroll: true }); if (caret) try { keepFocus.setSelectionRange(caret[0], caret[1]); } catch {} }
    else el._diff.focus({ preventScroll: true });
  }
  highlight(el);
}

// syntax colours, a slice at a time while the browser is idle, so a long file opens at once
function highlight(el) {
  const lang = langOf(el._f.path);
  if (!lang || el._f.binary) return;
  const run = el._hl;
  hljsFor(lang).then((hljs) => {
    const spans = [...el._diff.querySelectorAll('.cl-t')].slice(0, HL_LINES);
    let i = 0;
    const step = () => {
      if (el._hl !== run || !el.isConnected) return;
      const end = Math.min(spans.length, i + HL_CHUNK);
      for (; i < end; i++) {
        const sp = spans[i];
        const t = sp.textContent;
        if (!t.trim()) continue;
        try { sp.innerHTML = hljs.highlight(t, { language: lang, ignoreIllegals: true }).value; } catch {}
      }
      if (i < spans.length) idle(step);
    };
    idle(step);
  }).catch(() => {});
}

// the comments and comment boxes under their lines, and the ones whose line left the diff at the file's end
function drawNotes(c, el) {
  if (!el._drawn) return;
  for (const n of [...el._diff.querySelectorAll('.cl-notes, .cl-orph')]) n.remove();
  const path = el.dataset.path;
  const byKey = new Map();
  const add = (k, item) => { if (!byKey.has(k)) byKey.set(k, []); byKey.get(k).push(item); };
  for (const m of c.v.comments) if (m.path === path) add(m.k, { m });
  for (const [ek, w] of c.v.edits) if (w.path === path && !w.cid) add(w.k, { ek, w });
  const orphans = [];
  for (const [k, items] of byKey) {
    const row = el._lines?.has(k) ? el._diff.querySelector(`.cl[data-k="${k}"]`) : null;
    if (!row) { for (const it of items) if (it.m) orphans.push(it.m); continue; }
    const box = document.createElement('div');
    box.className = 'cl-notes';
    box.dataset.for = k;
    for (const it of items) box.appendChild(it.m ? commentNode(c, it.m) : editorNode(c, it.ek, it.w));
    row.after(box);
  }
  if (orphans.length) {
    const box = document.createElement('div');
    box.className = 'cl-orph';
    box.innerHTML = `<div class="cl-orph-h">${plural(orphans.length, 'comment')} on lines no longer in this diff</div>`;
    for (const m of orphans.sort((x, y) => lineNo(x.k) - lineNo(y.k))) box.appendChild(commentNode(c, m, true));
    el._diff.appendChild(box);
  }
}

function commentNode(c, m, where = false) {
  const ek = editKey(m.path, m.k, m.id);
  const w = c.v.edits.get(ek);
  if (w) return editorNode(c, ek, w);
  const div = document.createElement('div');
  div.className = 'cn';
  div.dataset.cid = m.id;
  const loc = where ? `<div class="cn-where">${esc(m.path)}:${lineNo(m.k)}${m.t === '+' ? ' (+)' : m.t === '-' ? ' (−)' : ''}${m.code ? ` · <span class="mono">${esc(m.code.slice(0, 80))}</span>` : ''}</div>` : '';
  div.innerHTML = `${loc}<div class="cn-text">${esc(m.text)}</div><div class="cn-acts">`
    + `<button type="button" class="cn-act" data-cedit>Edit</button><button type="button" class="cn-act" data-cdel>Delete</button></div>`;
  return div;
}

function editorNode(c, ek, w) {
  let ed = c.edNodes.get(ek);
  if (!ed) {
    ed = document.createElement('div');
    ed.className = 'cn-ed';
    ed.dataset.ed = ek;
    ed.innerHTML = `<textarea rows="2" spellcheck="true" placeholder="Comment on this line…" aria-label="comment"></textarea>`
      + `<div class="cn-ed-bar"><span class="cn-hint">Enter saves · Shift+Enter new line · Esc cancels</span>`
      + `<button type="button" class="cn-act" data-cancel>Cancel</button><button type="button" class="cn-act primary" data-save>${w.cid ? 'Save' : 'Comment'}</button></div>`;
    const ta = ed.querySelector('textarea');
    ta.value = w.draft || '';
    c.edNodes.set(ek, ed);
    requestAnimationFrame(() => grow(ta));
  }
  return ed;
}
function grow(ta) {
  if (!ta || ta.tagName !== 'TEXTAREA') return;
  ta.style.height = 'auto';
  ta.style.height = Math.min(220, ta.scrollHeight + 2) + 'px';
}

// comments whose file left the list: below it, so they can still be read, sent or deleted
function drawOrphans(c) {
  const shown = new Set(c.data ? c.data.files.map((f) => f.path) : []);
  const lost = c.data ? c.v.comments.filter((m) => !shown.has(m.path)) : [];
  c.orphans.textContent = '';
  c.orphans.hidden = !lost.length;
  if (!lost.length) return;
  const h = document.createElement('div');
  h.className = 'cl-orph-h';
  h.textContent = `${plural(lost.length, 'comment')} on files no longer in this list`;
  c.orphans.appendChild(h);
  for (const m of lost) c.orphans.appendChild(commentNode(c, m, true));
}

function drawFoot(c) {
  const n = c.v ? c.v.comments.length : 0;
  c.count.textContent = n ? plural(n, 'comment') : 'Click a line to comment on it';
  c.count.classList.toggle('faint', !n);
  c.sendBtn.disabled = !n;
  c.clearBtn.hidden = !n;
  if (!n) c.clearArm = 0;
  c.clearBtn.textContent = c.clearArm && Date.now() < c.clearArm ? `Clear ${n}?` : 'Clear';
}

// after any comment change: every open diff's notes, the badges, orphans and the footer
function redrawComments(c) {
  for (const el of c.fileEls.values()) { if (el._drawn) drawNotes(c, el); drawBadge(c, el); }
  drawOrphans(c);
  drawFoot(c);
}

// ---------- comments ----------
function openEditor(c, el, k, cid = null) {
  const path = el.dataset.path;
  const ek = editKey(path, k, cid);
  if (!c.v.edits.has(ek)) {
    const m = cid ? c.v.comments.find((x) => x.id === cid) : null;
    c.v.edits.set(ek, { path, k, cid, draft: m ? m.text : '' });
  }
  redrawComments(c);
  const ta = c.edNodes.get(ek)?.querySelector('textarea');
  if (ta) { ta.focus({ preventScroll: true }); ta.setSelectionRange(ta.value.length, ta.value.length); ta.scrollIntoView({ block: 'nearest' }); }
}

function closeEditor(c, ek, keep) {
  const w = c.v.edits.get(ek);
  const ed = c.edNodes.get(ek);
  const el = c.fileEls.get(w?.path);
  if (w && keep) {
    const text = (ed?.querySelector('textarea')?.value ?? w.draft ?? '').replace(/\s+$/, '');
    if (w.cid) {
      const m = c.v.comments.find((x) => x.id === w.cid);
      if (m) { if (text.trim()) m.text = text; else c.v.comments = c.v.comments.filter((x) => x !== m); }
    } else if (text.trim()) {
      const ln = el?._lines?.get(w.k);
      c.v.comments.push({ id: Math.random().toString(36).slice(2, 10), path: w.path, k: w.k, t: ln?.t || (w.k[0] === 'a' ? '-' : ' '),
        code: ln ? ln.text : '', text, base: c.v.base, at: Date.now() });
    }
    save(c.id);
  }
  c.v.edits.delete(ek);
  c.edNodes.delete(ek);
  redrawComments(c);
  // back to the diff, on the line, so the keys carry on from there
  if (el?._drawn) {
    const row = el._diff.querySelector(`.cl[data-k="${w?.k}"]`);
    if (row) setCursor(el, row);
    el._diff.focus({ preventScroll: true });
  }
}

function deleteComment(c, cid) {
  c.v.comments = c.v.comments.filter((m) => m.id !== cid);
  save(c.id);
  redrawComments(c);
}

// the one message Claude gets
function reviewText(c) {
  const d = c.data;
  const label = c.v.base === 'branch' ? `whole branch${d?.baseRef ? ` vs ${d.baseRef}` : ''}` : 'uncommitted';
  const list = [...c.v.comments].sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : lineNo(x.k) - lineNo(y.k)));
  const items = list.map((m, i) => {
    const sign = m.t === '+' ? ' (+)' : m.t === '-' ? ' (-, old line)' : '';
    let code = String(m.code || '').trim();
    if (code.length > CODE_CAP) code = code.slice(0, CODE_CAP) + '…';
    const body = m.text.split('\n').map((l) => '   ' + l).join('\n');
    return `${i + 1}. ${m.path}:${lineNo(m.k)}${sign}\n   > ${code || '(empty line)'}\n${body}`;
  });
  return `Review comments on your changes (${label}):\n\n${items.join('\n\n')}`;
}

function send(c) {
  if (!c.v.comments.length) return;
  handToChat(c.id, { text: reviewText(c), send: true });
  c.v.comments = [];
  save(c.id);
  redrawComments(c);
}

// ---------- the line cursor (keys in an open diff) ----------
function setCursor(el, row) {
  el._diff.querySelector('.cl.cur')?.classList.remove('cur');
  if (!row) { el._cur = null; return; }
  row.classList.add('cur');
  el._cur = row.dataset.k;
  row.scrollIntoView({ block: 'nearest' });
}
function moveCursor(el, by) {
  const rows = el._diff.querySelectorAll('.cl');
  if (!rows.length) return;
  const cur = el._cur ? el._diff.querySelector(`.cl[data-k="${el._cur}"]`) : null;
  let i = cur ? [...rows].indexOf(cur) : (by > 0 ? -1 : rows.length);
  i = Math.max(0, Math.min(rows.length - 1, i + by));
  setCursor(el, rows[i]);
}

// ---------- events ----------
function toggleFile(c, el) {
  const p = el.dataset.path;
  const open = !c.v.open.has(p);
  if (open) c.v.open.add(p); else c.v.open.delete(p);
  el.classList.toggle('open', open);
  el._row.querySelector('.chg-fbtn')?.setAttribute('aria-expanded', String(open));
  el._diff.hidden = !open;
  if (open && !el._drawn) drawDiff(c, el);
}

function onClick(c, e) {
  const t = e.target;
  if (t.closest('a[data-act]')) return; // Open: the page's own link handler (app.js) takes it
  const baseBtn = t.closest('[data-base]');
  if (baseBtn) {
    if (!c.v || baseBtn.dataset.base === c.v.base) return;
    c.v.base = baseBtn.dataset.base;
    save(c.id);
    c.gen++; c.busy = false; c.data = null; c.sig = ''; c.error = '';
    for (const el of c.fileEls.values()) el._json = null; // redraw rows: the same file can differ between the two
    drawBar(c); drawState(c);
    load(c, false);
    return;
  }
  if (t.closest('[data-refresh]')) { load(c, true); return; }
  if (t.closest('[data-send]')) { send(c); return; }
  if (t.closest('[data-clear]')) {
    if (c.clearArm && Date.now() < c.clearArm) { c.v.comments = []; c.clearArm = 0; save(c.id); redrawComments(c); return; }
    c.clearArm = Date.now() + 3000;
    drawFoot(c);
    setTimeout(() => drawFoot(c), 3100);
    return;
  }
  const fileEl = t.closest('.chg-file');
  const orphanBox = t.closest('.chg-orphans');
  if (!fileEl && !orphanBox) return;
  const ed = t.closest('.cn-ed');
  if (ed) {
    if (t.closest('[data-save]')) closeEditor(c, ed.dataset.ed, true);
    else if (t.closest('[data-cancel]')) closeEditor(c, ed.dataset.ed, false);
    return;
  }
  const cn = t.closest('.cn');
  if (cn) {
    const m = c.v.comments.find((x) => x.id === cn.dataset.cid);
    if (!m) return;
    if (t.closest('[data-cdel]')) deleteComment(c, m.id);
    else if (t.closest('[data-cedit]')) {
      const el = c.fileEls.get(m.path);
      if (el && el._drawn && !el._diff.hidden) openEditor(c, el, m.k, m.id);
      else { // its file is closed or gone: edit it where it shows
        c.v.edits.set(editKey(m.path, m.k, m.id), { path: m.path, k: m.k, cid: m.id, draft: m.text });
        redrawComments(c);
        c.edNodes.get(editKey(m.path, m.k, m.id))?.querySelector('textarea')?.focus();
      }
    }
    return;
  }
  if (!fileEl) return;
  if (t.closest('.chg-fbtn')) { toggleFile(c, fileEl); return; }
  const row = t.closest('.cl[data-k]');
  if (row) {
    // selecting text in a line is not a click on it
    if (!t.closest('.cl-plus') && String(window.getSelection?.() || '').length) return;
    setCursor(fileEl, row);
    openEditor(c, fileEl, row.dataset.k);
  }
}

function onKey(c, e) {
  const t = e.target;
  // a comment box owns the keyboard: none of the page's single-key shortcuts fire while typing
  if (t.tagName === 'TEXTAREA') {
    e.stopPropagation();
    const ed = t.closest('.cn-ed');
    if (!ed) return;
    const plain = !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && !e.isComposing;
    if (e.key === 'Enter' && plain) { e.preventDefault(); closeEditor(c, ed.dataset.ed, true); }
    else if (e.key === 'Escape') { e.preventDefault(); closeEditor(c, ed.dataset.ed, false); }
    return;
  }
  // Tab moves between the pane's buttons instead of switching views
  if (e.key === 'Tab') { e.stopPropagation(); return; }
  const diff = t.classList?.contains('chg-diff') ? t : null;
  if (!diff || e.ctrlKey || e.altKey || e.metaKey) return;
  const el = diff.closest('.chg-file');
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'j' || e.key === 'k') {
    e.preventDefault(); e.stopPropagation();
    moveCursor(el, e.key === 'ArrowDown' || e.key === 'j' ? 1 : -1);
  } else if (e.key === 'Enter' || e.key === 'c') {
    e.preventDefault(); e.stopPropagation();
    if (el._cur) openEditor(c, el, el._cur); else moveCursor(el, 1);
  } else if (e.key === 'Escape' && el._cur) {
    e.preventDefault(); e.stopPropagation();
    setCursor(el, null);
  }
}

export const _test = { reviewText, lineKey, absOf, splitPath };
