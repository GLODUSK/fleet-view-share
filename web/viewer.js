// In-app file viewer: a file path in the chat (the file on a Read, Edit, Write, MultiEdit or NotebookEdit row, a
// `path` or `path:line` in a reply, a Grep or Glob result) opens here instead of VS Code.
//
// openViewer({ path, cwd, line, find }) asks the server for it (GET /file, see files.js: only what lies inside the
// folders Fleet View knows; a relative path is read against cwd) and shows it in a large frosted overlay over the
// page: the path, the lines numbered and highlighted (highlight.js, the grammars the chat's code blocks use),
// scrolled to `line` and marked. With `find` and no line it goes to the first line holding find's first line (an
// edit's new text) and marks as many lines as find has. A folder lists what is in it (a click opens that one, ".."
// goes up); a picture shows as itself; a binary file only says so. A text file over 1 MB shows its first 1 MB.
//
// The head has Copy path, Open in VS Code (a folder: Open in Explorer; POST /reveal through app.js's own link
// handling, at the marked line) and Close. Esc or a click beside the window closes it, and the focus goes back to
// where it was. While it is up, the page's own keys stay out of it and the page behind it is hidden from assistive
// tech and from Ctrl+F (find.js skips aria-hidden), so find searches only the file.
//
// A path the server can't find opens nothing: a toast says so. That is how the chat's links are checked: a
// path-looking bit of a reply is a link straight away, and only a click asks whether it is there.
import { esc, C } from './cards.js';
import { icon } from './icons.js';
import { highlighter, LANG_ALIAS, copyText } from './chat.js';

const HL_MAX = 400000; // characters highlighted at most; a bigger file shows plain
const LINE_PX = 19; // the code's line height (viewer.css says the same)
const PAD_PX = 10; // the code's top padding (viewer.css)

let cur = null; // the overlay while it is up: { el, body, head, hidden: [elements], back: element, seq }
let seq = 0;

const kb = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);
const nameOf = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || String(p || '');
const sepOf = (p) => (/\\/.test(p) || /^[a-z]:/i.test(p) ? '\\' : '/');

// a toast like app.js's (the viewer has no ui handle)
export function note(text, color = C.dim) {
  const box = document.getElementById('toasts');
  if (!box) return;
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `<span class="toast-dot" style="background:${esc(color)}"></span><span class="toast-t">${esc(text)}</span>`;
  box.appendChild(el);
  setTimeout(() => el.classList.add('gone'), 4000);
  setTimeout(() => el.remove(), 4800);
}

// VS Code at the file (and line), or Explorer at a folder: the page's own "open" link, which app.js handles
// (POST /reveal, then its toast), so it behaves like every other one
export function openInCode(p, line = 0, kind = 'file') {
  if (!p) return;
  const a = document.createElement('a');
  a.href = '#';
  a.hidden = true;
  a.dataset.act = 'reveal';
  a.dataset.kind = kind;
  a.dataset.path = p;
  if (line > 0) a.dataset.line = String(line);
  document.body.appendChild(a);
  a.click();
  a.remove();
}

async function fetchFile(p, cwd) {
  const u = `/file?path=${encodeURIComponent(p)}${cwd ? `&cwd=${encodeURIComponent(cwd)}` : ''}`;
  let r;
  try { r = await fetch(u, { cache: 'no-store' }); } catch { return { ok: false, message: 'Fleet View did not answer' }; }
  let j = null;
  try { j = await r.json(); } catch {}
  return j && typeof j === 'object' ? j : { ok: false, message: `the server said ${r.status}` };
}

// the first line (1-based) holding find's first non-empty line, and how many lines find has; 0 when it isn't there
export function findLine(text, find) {
  const want = String(find || '').split('\n').map((l) => l.trim()).find(Boolean);
  if (!want) return { line: 0, span: 0 };
  const i = String(text || '').split(/\r?\n/).findIndex((l) => l.includes(want));
  return i < 0 ? { line: 0, span: 0 } : { line: i + 1, span: String(find).replace(/\n+$/, '').split('\n').length };
}

// -> the server's answer ({ ok, … }); nothing opens unless ok
export async function openViewer(o = {}) {
  const p = String(o.path || '').trim();
  if (!p) return { ok: false };
  const my = ++seq;
  const f = await fetchFile(p, o.cwd);
  if (my !== seq) return { ok: false };
  if (!f.ok) {
    note(f.missing ? `${nameOf(p)} isn't there (${f.path || p})` : `Couldn't open ${nameOf(p)}: ${f.message || 'unknown error'}`, f.missing ? C.dim : C.red);
    return f;
  }
  show(f, o, my);
  return f;
}

export const viewerOpen = () => !!cur;
export function closeViewer() {
  const v = cur;
  if (!v) return;
  cur = null;
  seq++;
  window.removeEventListener('keydown', v.onKey, true);
  v.el.remove();
  for (const el of v.hidden) { el.removeAttribute('aria-hidden'); el.inert = false; }
  try { if (v.back?.isConnected) v.back.focus({ preventScroll: true }); } catch {}
}

function build() {
  const el = document.createElement('div');
  el.className = 'fv-viewer';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.tabIndex = -1;
  el.innerHTML = `<div class="fvv-win">
  <div class="fvv-head">
    <span class="fvv-ic"></span>
    <span class="fvv-path"><span class="fvv-dir"></span><span class="fvv-name"></span></span>
    <span class="fvv-meta"></span>
    <span class="grow"></span>
    <button type="button" class="fvv-b" data-v="copy" title="Copy the full path">${icon('copy', 14)}<span>Copy path</span></button>
    <a class="fvv-b fvv-code-b" href="#" data-act="reveal" data-kind="file" data-path="">${icon('external', 14)}<span>Open in VS Code</span></a>
    <button type="button" class="fvv-x" data-v="close" title="Close (Esc)" aria-label="close">${icon('close', 16)}</button>
  </div>
  <div class="fvv-body" tabindex="0"></div>
</div>`;
  const v = { el, body: el.querySelector('.fvv-body'), hidden: [], back: document.activeElement, path: '', seq: 0 };
  // Esc closes, before the page's own Esc (which would close the panel behind); find's bar keeps its own keys
  v.onKey = (e) => {
    if (e.key !== 'Escape' || e.target?.closest?.('.fv-find')) return;
    e.preventDefault(); e.stopPropagation();
    closeViewer();
  };
  window.addEventListener('keydown', v.onKey, true);
  // the page's single-key shortcuts (app.js listens on the document) stay out while the viewer has the keyboard
  el.addEventListener('keydown', (e) => e.stopPropagation());
  el.addEventListener('pointerdown', (e) => { if (e.target === el) closeViewer(); });
  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-v]');
    if (!b) return;
    const k = b.dataset.v;
    if (k === 'close') closeViewer();
    else if (k === 'copy') {
      copyText(v.path);
      const t = b.querySelector('span');
      t.textContent = 'Copied';
      clearTimeout(b._t);
      b._t = setTimeout(() => { t.textContent = 'Copy path'; }, 1400);
    } else if (k === 'entry') {
      const name = b.dataset.name;
      const p = name === '..' ? v.path.replace(/[\\/][^\\/]*[\\/]?$/, '') || v.path : `${v.path.replace(/[\\/]+$/, '')}${sepOf(v.path)}${name.replace(/\/$/, '')}`;
      openViewer({ path: p });
    }
  });
  document.body.appendChild(el);
  // the page behind: hidden from assistive tech and find.js, and out of the tab order
  for (const x of document.body.children) {
    if (x === el || x.classList.contains('fv-find') || x.id === 'toasts' || x.tagName === 'SCRIPT' || x.hasAttribute('aria-hidden')) continue;
    x.setAttribute('aria-hidden', 'true');
    x.inert = true;
    v.hidden.push(x);
  }
  return v;
}

function show(f, o, my) {
  if (!cur) cur = build();
  const v = cur;
  v.seq = my;
  v.path = f.path;
  const { el, body } = v;
  const isDir = !!f.dir;
  const name = nameOf(f.path), dir = f.path.slice(0, f.path.length - name.length).replace(/[\\/]+$/, '');
  el.setAttribute('aria-label', `${isDir ? 'folder' : 'file'} ${name}`);
  el.querySelector('.fvv-ic').innerHTML = icon(isDir ? 'folder' : 'file', 15);
  el.querySelector('.fvv-dir').textContent = dir ? `${dir}${sepOf(f.path)}` : '';
  el.querySelector('.fvv-name').textContent = name + (isDir ? sepOf(f.path) : '');
  el.querySelector('.fvv-path').title = f.path;
  const code = el.querySelector('.fvv-code-b');
  code.dataset.kind = isDir ? 'folder' : 'file';
  code.dataset.path = f.path;
  code.querySelector('span').textContent = isDir ? 'Open in Explorer' : 'Open in VS Code';
  code.title = isDir ? 'Open the folder in Explorer' : 'Open the file in VS Code (Ctrl+click on a path in the chat does this too)';
  delete code.dataset.line;
  const meta = el.querySelector('.fvv-meta');
  body.scrollTop = 0;
  body.scrollLeft = 0;

  if (isDir) {
    const list = (f.entries || []).map((n) => `<button type="button" class="fvv-ent${/\/$/.test(n) ? ' dir' : ''}" data-v="entry" data-name="${esc(n)}">${icon(/\/$/.test(n) ? 'folder' : 'file', 14)}<span>${esc(n)}</span></button>`);
    meta.textContent = `${f.total ?? list.length} ${f.total === 1 ? 'entry' : 'entries'}`;
    body.innerHTML = `<div class="fvv-dirlist"><button type="button" class="fvv-ent dir" data-v="entry" data-name="..">${icon('up', 14)}<span>..</span></button>${list.join('')}</div>`
      + (f.total > list.length ? `<div class="fvv-note">and ${f.total - list.length} more</div>` : '');
  } else if (f.image) {
    meta.textContent = kb(f.size || 0);
    body.innerHTML = `<div class="fvv-img"><img alt="${esc(name)}" src="/file?raw=1&amp;path=${esc(encodeURIComponent(f.path))}"></div>`;
  } else if (f.binary) {
    meta.textContent = kb(f.size || 0);
    body.innerHTML = `<div class="fvv-empty">${icon('file', 16)}<span>A binary file (${esc(kb(f.size || 0))}): it can't be shown here. Open it in VS Code or Explorer instead.</span></div>`;
  } else {
    showText(v, f, o, meta);
  }
  if (document.activeElement === document.body || !el.contains(document.activeElement)) body.focus({ preventScroll: true });
}

function showText(v, f, o, meta) {
  const { body, el } = v;
  const text = String(f.text || '');
  const n = Math.max(1, f.lines || 0);
  const lang = String(f.lang || '');
  meta.textContent = `${n} ${n === 1 ? 'line' : 'lines'} · ${kb(f.size || 0)}${lang ? ` · ${lang}` : ''}`;
  let nums = '';
  for (let i = 1; i <= n; i++) nums += i === 1 ? '1' : `\n${i}`;
  body.innerHTML = `<div class="fvv-codebox"><div class="fvv-mark" hidden></div><div class="fvv-gut" aria-hidden="true">${nums}</div>`
    + `<pre class="fvv-pre"><code>${esc(text.replace(/\r?\n$/, ''))}</code></pre></div>`
    + (f.truncated ? `<div class="fvv-note">The first ${kb(text.length)} of ${kb(f.size || 0)}: open it in VS Code for the rest</div>` : '')
    + (!text ? '<div class="fvv-note">The file is empty</div>' : '');
  // the line to go to and mark
  let line = Number(o.line) > 0 ? Math.floor(Number(o.line)) : 0, span = 1;
  if (!line && o.find) ({ line, span } = findLine(text, o.find));
  if (line) {
    line = Math.min(line, n);
    span = Math.max(1, Math.min(span || 1, n - line + 1, 400));
    const mark = body.querySelector('.fvv-mark');
    mark.style.top = `${PAD_PX + (line - 1) * LINE_PX}px`;
    mark.style.height = `${span * LINE_PX}px`;
    mark.hidden = false;
    el.querySelector('.fvv-code-b').dataset.line = String(line);
    requestAnimationFrame(() => { body.scrollTop = Math.max(0, PAD_PX + (line - 1) * LINE_PX - body.clientHeight / 3); });
  }
  // highlighted once highlight.js is there (it is, once the chat showed)
  if (!lang || text.length > HL_MAX) return;
  const my = v.seq;
  highlighter().then((hljs) => {
    if (cur !== v || v.seq !== my) return;
    const name = hljs.getLanguage(lang) ? lang : LANG_ALIAS[lang];
    if (!name || !hljs.getLanguage(name)) return;
    const codeEl = body.querySelector('.fvv-pre code');
    if (!codeEl) return;
    try { codeEl.innerHTML = hljs.highlight(codeEl.textContent, { language: name, ignoreIllegals: true }).value; codeEl.classList.add('hljs'); } catch {}
  }, () => {});
}
