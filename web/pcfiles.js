// The PC's folders and files from a page that is not the desktop window: Edge on this PC, or a browser on another
// computer through Tailscale (remote.js). The desktop window has the Windows folder dialog (fleetDesktop.pickFolder)
// and knows where a dropped, picked or pasted file is on disk (fleetDesktop.pathForFile); a browser has neither, so:
//
//   pickFolder({ title, button }) -> Promise<{ ok: true, path } | { ok: false, message? }>   the shape the desktop's
//       pickFolder answers, so its callers don't change. In the desktop window it is that dialog; elsewhere an in-page
//       one over GET /folders (files.js): "This PC" (the drives, and starting places: home, a Github folder, the
//       repos Fleet View lists), breadcrumbs, a path box to type or paste into, the folders of the folder it is in
//       (no files). A click picks a folder, Enter or a double-click goes into it, Backspace (or Alt+↑) goes up, a
//       letter jumps to the next name starting with it, Esc or a click beside it cancels. "Choose this folder" takes
//       the picked one, else the folder it is in. It opens where the last pick was (this browser's localStorage).
//   canPickFolder() -> whether pickFolder can be offered (not with ?fixture=1, which has no server to list folders)
//   uploads() -> true when a file needs sending to the PC to have a path there (no fleetDesktop.pathForFile)
//   droppedFolders(dataTransfer) -> Set of the names of the folders in a drop (call it in the drop event itself): a
//       browser hands a dropped folder over as a File it can't read, and has no path for it, so it can't be sent
//   upload(file, onProgress(sent, total)) -> { done: Promise<{ ok, path, name, size } | { ok: false, message }>, abort() }
//       POST /upload?name=<its name>, its bytes as the body (XMLHttpRequest, for the progress a fetch can't give);
//       never rejects. The server keeps it under %LOCALAPPDATA%\fleet-view\uploads for a week.
import { esc } from './cards.js';
import { icon } from './icons.js';

export const UPLOAD_MAX = 200 * 1024 * 1024; // the server's limit for one file (files.js)
const FIXTURE = (() => { try { return new URLSearchParams(location.search).has('fixture'); } catch { return false; } })();
const LAST_KEY = 'fv.pickFolder.last';

const desk = () => (typeof window.fleetDesktop?.pickFolder === 'function' ? window.fleetDesktop : null);
export const canPickFolder = () => !!desk() || !FIXTURE;
export const uploads = () => typeof window.fleetDesktop?.pathForFile !== 'function';
export const sizeText = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(n < 10485760 ? 1 : 0)} MB`);

// ---------- uploads ----------
export function upload(file, onProgress = null) {
  const name = String(file?.name || '') || `pasted-${Date.now()}`;
  let xhr = null, settle = null;
  const done = new Promise((resolve) => { settle = resolve; });
  if (!file || typeof file.size !== 'number') { settle({ ok: false, message: 'not a file' }); return { done, abort() {} }; }
  if (file.size > UPLOAD_MAX) { settle({ ok: false, message: `${name} is ${sizeText(file.size)}: at most ${sizeText(UPLOAD_MAX)} goes to the PC at once` }); return { done, abort() {} }; }
  if (FIXTURE) {
    // fixture data: nothing reaches a server; recorded like app.js records its POSTs
    try { window.__fvPosts?.push({ url: '/upload', body: { name, bytes: file.size } }); } catch {}
    settle({ ok: true, path: `C:\\Users\\you\\AppData\\Local\\fleet-view\\uploads\\fixture\\${name}`, name, size: file.size });
    return { done, abort() {} };
  }
  xhr = new XMLHttpRequest();
  xhr.open('POST', `/upload?name=${encodeURIComponent(name)}`);
  if (file.type) xhr.setRequestHeader('Content-Type', file.type);
  xhr.responseType = 'json';
  if (onProgress) xhr.upload.onprogress = (e) => { try { onProgress(e.loaded, e.lengthComputable ? e.total : file.size); } catch {} };
  xhr.onload = () => {
    const j = xhr.response && typeof xhr.response === 'object' ? xhr.response : null;
    if (xhr.status === 200 && j && j.ok && typeof j.path === 'string') settle(j);
    else settle({ ok: false, message: (j && j.message) || `the PC said ${xhr.status}` });
  };
  xhr.onerror = () => settle({ ok: false, message: 'the connection to the PC dropped while sending it' });
  xhr.onabort = () => settle({ ok: false, message: 'cancelled', aborted: true });
  xhr.send(file);
  return { done, abort: () => { try { xhr.abort(); } catch {} } };
}

export function droppedFolders(dt) {
  const out = new Set();
  for (const it of dt?.items || []) {
    try { const e = it.kind === 'file' && typeof it.webkitGetAsEntry === 'function' ? it.webkitGetAsEntry() : null; if (e && e.isDirectory) out.add(e.name); } catch {}
  }
  return out;
}

// ---------- the folder picker ----------
let open = null; // the dialog while it is up: { close(result) }

export async function pickFolder(o = {}) {
  const d = desk();
  if (d) { try { return (await d.pickFolder()) || { ok: false }; } catch (e) { return { ok: false, message: String(e?.message || e) }; } }
  if (FIXTURE) return { ok: false, message: 'fixture data: there are no folders to pick' };
  if (open) open.close({ ok: false });
  return new Promise((resolve) => { open = mount(o, resolve); });
}

async function listOf(p) {
  let r;
  try { r = await fetch(p ? `/folders?path=${encodeURIComponent(p)}` : '/folders', { cache: 'no-store' }); } catch { return { ok: false, message: 'Fleet View on the PC did not answer' }; }
  let j = null;
  try { j = await r.json(); } catch {}
  return j && typeof j === 'object' ? j : { ok: false, message: `the PC said ${r.status}` };
}
const lastPick = () => { try { return localStorage.getItem(LAST_KEY) || null; } catch { return null; } };
const keepPick = (p) => { try { localStorage.setItem(LAST_KEY, p); } catch {} };
const sepOf = (p) => (/^[a-z]:/i.test(p) || p.includes('\\') ? '\\' : '/');
// the breadcrumbs of a path: [{ name, path }], the drive first ("C:" for C:\)
function crumbs(p) {
  if (!p) return [];
  const sep = sepOf(p), out = [];
  const parts = p.split(/[\\/]/).filter(Boolean);
  let at = '';
  parts.forEach((part, i) => {
    at = i === 0 ? (sep === '\\' ? `${part}\\` : `/${part}`) : `${at.replace(/[\\/]$/, '')}${sep}${part}`;
    out.push({ name: part, path: at });
  });
  if (sep === '/') out.unshift({ name: '/', path: '/' });
  return out;
}

function mount(o, resolve) {
  const veil = document.createElement('div');
  veil.className = 'fp-veil';
  veil.innerHTML = `<div class="fp" role="dialog" aria-modal="true" aria-labelledby="fp-title">
  <div class="fp-head"><span class="fp-hic">${icon('folder', 16)}</span><b id="fp-title">${esc(o.title || 'Choose a folder')}</b><span class="fp-sub">on the PC</span><span class="grow"></span><button type="button" class="fp-x" data-fp="cancel" title="Cancel (Esc)" aria-label="cancel">${icon('close', 14)}</button></div>
  <form class="fp-pathrow" autocomplete="off"><input class="fp-in mono" type="text" spellcheck="false" placeholder="Type or paste a folder path, like Z:\\Github" aria-label="folder path"><button type="submit" class="btn fp-go">Go</button></form>
  <nav class="fp-crumbs" aria-label="where you are"></nav>
  <div class="fp-body">
    <div class="fp-side" aria-label="places"></div>
    <div class="fp-list" role="listbox" tabindex="0" aria-label="folders"></div>
  </div>
  <div class="fp-note" hidden></div>
  <div class="fp-foot"><span class="fp-sel mono" title=""></span><button type="button" class="btn" data-fp="cancel">Cancel</button><button type="button" class="btn primary" data-fp="choose">${esc(o.button || 'Choose this folder')}</button></div>
</div>`;
  const $ = (s) => veil.querySelector(s);
  const box = $('.fp'), input = $('.fp-in'), crumbEl = $('.fp-crumbs'), side = $('.fp-side'), list = $('.fp-list'), note = $('.fp-note'), selEl = $('.fp-sel'), chooseBtn = $('[data-fp="choose"]');
  const back = document.activeElement;
  // cur: the folder shown (null: This PC); rows: what the list shows; sel: the picked row's index (-1: none)
  const st = { cur: null, rows: [], sel: -1, seq: 0, root: null, loading: false };
  let finished = false;

  function close(result) {
    if (finished) return;
    finished = true;
    if (open && open.close === close) open = null;
    veil.remove();
    try { back?.focus?.(); } catch {}
    if (result && result.ok && result.path) keepPick(result.path);
    resolve(result || { ok: false });
  }

  function say(text, warn = false) {
    note.hidden = !text;
    note.textContent = text || '';
    note.classList.toggle('warn', !!warn);
  }
  // what "Choose" would take: the picked row, else the folder shown
  const choice = () => (st.sel >= 0 && st.rows[st.sel] ? st.rows[st.sel].path : st.cur);
  function drawFoot() {
    const p = choice();
    selEl.textContent = p || 'Pick a drive or a folder';
    selEl.title = p || '';
    chooseBtn.disabled = !p || st.loading;
  }
  function drawCrumbs() {
    const cs = crumbs(st.cur);
    crumbEl.innerHTML = `<button type="button" class="fp-crumb" data-go="">This PC</button>`
      + cs.map((c, i) => `${icon('chevron', 12)}<button type="button" class="fp-crumb${i === cs.length - 1 ? ' on' : ''}" data-go="${esc(c.path)}"${i === cs.length - 1 ? ' aria-current="location"' : ''}>${esc(c.name)}</button>`).join('');
    crumbEl.scrollLeft = crumbEl.scrollWidth;
  }
  function drawSide() {
    const r = st.root;
    if (!r) { side.innerHTML = ''; return; }
    const row = (x, ic) => `<button type="button" class="fp-place${st.cur && x.path.toLowerCase() === st.cur.toLowerCase() ? ' on' : ''}" data-go="${esc(x.path)}" title="${esc(x.path)}">${icon(ic, 14)}<span>${esc(x.name)}</span></button>`;
    side.innerHTML = `<div class="fp-sh">Drives</div>${(r.folders || []).map((x) => row(x, 'repo')).join('')}`
      + ((r.places || []).length ? `<div class="fp-sh">Places</div>${r.places.map((x) => row(x, 'folder')).join('')}` : '');
  }
  function drawList() {
    if (!st.rows.length) {
      list.innerHTML = st.loading ? '' : `<div class="fp-empty">${st.cur ? 'No folders in here' : 'No drives found'}</div>`;
    } else {
      list.innerHTML = st.rows.map((x, i) => `<div class="fp-row${i === st.sel ? ' on' : ''}" role="option" id="fp-r${i}" data-i="${i}" aria-selected="${i === st.sel}" title="${esc(x.path)}">${icon(st.cur ? 'folder' : x.drive ? 'repo' : 'folder', 15)}<span class="fp-n">${esc(x.name)}</span>${x.sub ? `<span class="fp-d mono">${esc(x.sub)}</span>` : ''}</div>`).join('');
    }
    if (st.sel >= 0) list.setAttribute('aria-activedescendant', `fp-r${st.sel}`); else list.removeAttribute('aria-activedescendant');
    drawFoot();
  }
  function pick(i, scroll = true) {
    st.sel = Math.max(-1, Math.min(st.rows.length - 1, i));
    for (const el of list.querySelectorAll('.fp-row')) {
      const on = Number(el.dataset.i) === st.sel;
      el.classList.toggle('on', on);
      el.setAttribute('aria-selected', String(on));
    }
    if (st.sel >= 0) {
      list.setAttribute('aria-activedescendant', `fp-r${st.sel}`);
      if (scroll) list.querySelector(`#fp-r${st.sel}`)?.scrollIntoView({ block: 'nearest' });
    }
    drawFoot();
  }

  // show a folder (null: This PC); the row named `from` is picked (going up keeps your place)
  // soft: a folder that is gone (the last pick, deleted since) quietly shows its parent instead
  async function go(p, from = null, soft = false) {
    const my = ++st.seq;
    st.loading = true; drawFoot();
    const busy = setTimeout(() => { if (my === st.seq) say('Reading the folder…'); }, 300);
    const j = await listOf(p);
    clearTimeout(busy);
    if (my !== st.seq || finished) return;
    st.loading = false;
    if (!j.ok) {
      if (soft && j.missing && j.parent) { go(j.parent, null, true); return; }
      say(j.message || 'Could not read that folder', true);
      // a file: show the folder it is in, with the file's own folder picked
      if (j.file && j.parent && p !== j.parent) { go(j.parent); return; }
      input.value = st.cur || '';
      drawFoot();
      return;
    }
    say(j.more ? `Showing the first ${j.folders.length} of ${j.total} folders: type a path to go further` : '');
    if (!j.path) {
      st.root = j;
      st.cur = null;
      st.rows = [...(j.folders || []).map((x) => ({ ...x, drive: true })), ...(j.places || []).map((x) => ({ ...x, sub: x.path }))];
    } else {
      st.cur = j.path;
      st.rows = j.folders || [];
    }
    input.value = st.cur || '';
    const at = from ? st.rows.findIndex((x) => x.path.toLowerCase() === from.toLowerCase()) : -1;
    st.sel = at;
    drawCrumbs(); drawSide(); drawList();
    if (at >= 0) pick(at);
    else list.scrollTop = 0;
  }
  const up = () => { if (st.cur) { const c = st.cur, parent = crumbs(c).slice(-2, -1)[0]; go(parent ? parent.path : null, c); } };
  const enter = (i) => { const x = st.rows[i]; if (x) go(x.path); };

  // ----- events -----
  veil.addEventListener('mousedown', (e) => { if (e.target === veil) close({ ok: false }); });
  box.addEventListener('click', (e) => {
    const b = e.target.closest('[data-fp], [data-go]');
    if (b?.dataset.fp === 'cancel') close({ ok: false });
    else if (b?.dataset.fp === 'choose') { const p = choice(); if (p) close({ ok: true, path: p }); }
    else if (b && b.dataset.go != null) go(b.dataset.go || null);
  });
  list.addEventListener('click', (e) => { const r = e.target.closest('.fp-row'); if (r) pick(Number(r.dataset.i), false); });
  list.addEventListener('dblclick', (e) => { const r = e.target.closest('.fp-row'); if (r) enter(Number(r.dataset.i)); });
  $('.fp-pathrow').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = input.value.trim().replace(/^(["'])(.*)\1$/, '$2').trim();
    go(v || null);
    list.focus();
  });
  let typed = '', typedAt = 0;
  // the page's own keys never see what is typed here
  veil.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); close({ ok: false }); return; }
    if (e.key === 'Tab') {
      // focus stays in the dialog
      const f = [...box.querySelectorAll('button:not(:disabled), input, [tabindex="0"]')].filter((x) => x.offsetParent !== null);
      const i = f.indexOf(document.activeElement);
      if (e.shiftKey ? i <= 0 : i === f.length - 1) { e.preventDefault(); (e.shiftKey ? f[f.length - 1] : f[0])?.focus(); }
      return;
    }
    if (e.target === input) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (e.altKey && e.key === 'ArrowUp') { e.preventDefault(); up(); return; }
      e.preventDefault();
      if (document.activeElement !== list) list.focus();
      pick(st.sel < 0 ? 0 : st.sel + (e.key === 'ArrowDown' ? 1 : -1));
    } else if (e.key === 'Home' || e.key === 'End') {
      if (e.target !== list) return;
      e.preventDefault(); pick(e.key === 'Home' ? 0 : st.rows.length - 1);
    } else if (e.key === 'Enter') {
      if (e.target !== list) return;
      e.preventDefault();
      if (e.ctrlKey) { const p = choice(); if (p) close({ ok: true, path: p }); } else if (st.sel >= 0) enter(st.sel);
    } else if (e.key === 'Backspace') {
      if (e.target !== list) return;
      e.preventDefault(); up();
    } else if (e.target === list && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      // type-ahead: the next folder whose name starts with what was typed (a pause starts over)
      const now = Date.now();
      typed = now - typedAt > 800 ? e.key.toLowerCase() : typed + e.key.toLowerCase();
      typedAt = now;
      const n = st.rows.length, from = typed.length === 1 ? st.sel + 1 : Math.max(st.sel, 0);
      for (let k = 0; k < n; k++) {
        const i = (from + k) % n;
        if (st.rows[i].name.toLowerCase().startsWith(typed)) { pick(i); break; }
      }
    }
  });

  document.body.appendChild(veil);
  // This PC first (the drives and places for the side), then where the last pick was, in its folder
  const start = o.start || lastPick(), parent = start ? crumbs(start).slice(-2, -1)[0] : null;
  go(null).then(() => { if (start && !finished) go(parent ? parent.path : start, parent ? start : null, true); });
  setTimeout(() => list.focus(), 0);
  return { close };
}
