// Fleet View web: "Clone what's missing" (sync-clone.js on the server; docs/sync.md "Repos this machine lacks"). A repo
// whose synced chats have no checkout on this machine is cloned here, and its chats come over.
//
// Two places, both on this machine's own page only (a remote browser gets 403 and shows neither):
//   mountClone({ post, isRemote, fixture }): the card the page shows by itself, once, while GET /sync/missing says ask
//     (auto is off and some missing repo was never answered). It lists those repos, each ticked; the folder they go in
//     (changeable); "Clone new repos automatically from now on" (ticked); Clone and Not now. Clone posts
//     /sync/clone { origins: the ticked, skip: the unticked, folder, auto }, then shows each repo's progress (GET
//     /sync/clone?id= every 1.5 s) until it and its installs are done. Not now posts /sync/missing { notNow: true }: the
//     card comes back only when a new repo goes missing. Its × hides it until the page loads again. GET /sync/missing
//     is read 8 s after the page loads and every minute after (every 5 minutes while sync is off here: 404).
//   cloneSection(el, { post, isRemote, fixture }) -> { stop() }: the Sync card's "Repos" part (sync.js mounts it while
//     the card is open): every missing repo with its state and a Clone button, the clones under way and their
//     installs, "Clone new repos automatically" (POST /sync/missing { auto }) and the clone folder, with Change
//     (POST /sync/missing { folder }; empty: the default). Read every 3 s while it shows.
//   cloneWorkspaceItem({ root, name, sessions }) -> the workspace right-click menu's "Clone workspace to this machine"
//     ({ label, icon, note, run }), or null: shown only on this machine's own page (mountClone ran) and only when some
//     of the workspace's chats (sessions: /state's, those whose repo is root) run on another computer (syncOwner):
//     there is nothing to copy otherwise. Its run opens a card that posts /sync/clone-workspace { repo: root } and
//     shows the job (GET /sync/clone-workspace?id= every 1.5 s): the checkout, the work brought over, the chats copied
//     as this machine's own (the newest 20), and the notes. One card at a time.
// Controls use data-cl, never data-c (the Sync card's own) or data-act (app.js takes those clicks).
import { esc } from './cards.js';
import { icon } from './icons.js';

const FIRST_MS = 8e3, POLL_MS = 60e3, OFF_MS = 5 * 60e3, JOB_MS = 1500, SECTION_MS = 3000;
const n = (k, one, many) => `${k} ${k === 1 ? one : many}`;
const ago = (iso) => {
  const t = Date.parse(iso || '');
  if (!t) return '';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`;
};
async function getJson(url) {
  try {
    const r = await fetch(url, { cache: 'no-store' });
    const j = await r.json().catch(() => null);
    return { status: r.status, j };
  } catch { return { status: 0, j: null }; }
}
// one clone's line: its state, then its install's
function itemLine(x) {
  const name = `<b>${esc(x.name)}</b>`;
  let t;
  if (x.state === 'queued') t = `${name}: waiting its turn`;
  else if (x.state === 'cloning') t = `${name}: cloning…`;
  else if (x.state === 'failed') t = `${name}: <span class="sy-bad">${esc(x.message || 'failed')}</span>`;
  else if (x.state === 'found') t = `${name}: ${esc(x.message || 'already here')}`;
  else t = `${name}: ${esc(x.message || 'cloned')}`;
  const i = x.install;
  if (i && i.state === 'waiting') t += ` <span class="sy-dim">· then ${esc(i.message)}</span>`;
  else if (i && i.state === 'running') t += ` <span class="sy-dim">· ${esc(i.message)}…</span>`;
  else if (i && i.state === 'done') t += ` <span class="sy-dim">· ${esc(i.message)} done</span>`;
  else if (i && (i.state === 'failed' || i.state === 'missing')) t += ` <span class="sy-warn">· ${esc(i.message)}</span>`;
  return `<div class="sy-line cl-item">${t}</div>`;
}
const settled = (job) => !!job && job.done && !job.items.some((x) => x.install && ['waiting', 'running'].includes(x.install.state));
let wsCtx = null; // { post, isRemote } once mountClone ran on this machine's own page

// ---------- the card the page shows by itself ----------
export function mountClone({ post, isRemote = () => false, fixture = false } = {}) {
  if (fixture || isRemote()) return { refresh() {} };
  wsCtx = { post, isRemote };
  let card = null, timer = null, hidden = false, view = null, job = null, note = null, busy = false;

  async function refresh() {
    clearTimeout(timer);
    const { status, j } = await getJson('/sync/missing');
    if (status === 200 && j && j.ok) {
      view = j;
      if (!card && !hidden && j.ask) open();
    }
    timer = setTimeout(refresh, status === 200 ? POLL_MS : OFF_MS);
  }
  function open() {
    card = document.createElement('div');
    card.className = 'uw-pop sy-pop cl-pop';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', 'Clone the repos your other machines work in');
    card.tabIndex = -1;
    document.body.appendChild(card);
    card.addEventListener('click', onClick);
    card.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); hide(); } });
    draw();
  }
  function close() {
    if (!card) return;
    card.remove();
    card = null;
    job = null;
    note = null;
  }
  const hide = () => { hidden = true; close(); };
  function askHtml() {
    const repos = view.repos.filter((r) => r.fresh);
    // a repo under an account this machine has nothing from: its whole name, a warning, and not ticked (a clone runs
    // its install, and the list comes from the synced data)
    const full = (r) => String(r.origin || '').replace(/^https:\/\/[^/]+\//, '');
    const rows = repos.map((r) => `<label class="cl-repo" title="${esc(r.origin)}"><input type="checkbox" data-o="${esc(r.origin)}"${r.trusted === false ? '' : ' checked'}>`
      + `<span class="cl-name">${esc(r.trusted === false ? full(r) : r.name)}</span><span class="sy-dim">${esc(n(r.chats, 'chat', 'chats'))}${r.newest ? ` · ${esc(ago(r.newest))}` : ''}</span>`
      + `${r.trusted === false ? '<span class="sy-warn cl-stranger">from an account this machine has no repo from: clone it only if you know it</span>' : ''}</label>`).join('');
    return `<div class="sy-sec"><div class="sy-line">Your other machines have chats in ${n(repos.length, 'repo', 'repos')} this one has no checkout of. Clone them, and their chats come here too.</div>`
      + `<div class="cl-list">${rows}</div></div>`
      + `<div class="sy-sec"><label class="cl-field"><span class="sy-dim">Into</span><input type="text" class="cl-folder" spellcheck="false" value="${esc(view.folder || '')}"></label>`
      + '<label class="cl-check"><input type="checkbox" class="cl-auto" checked><span>Clone new repos automatically from now on</span></label>'
      + `<div class="sy-btns"><button type="button" data-cl="clone" class="sy-go"${busy ? ' disabled' : ''}>Clone</button><button type="button" data-cl="notnow"${busy ? ' disabled' : ''}>Not now</button></div></div>`;
  }
  function jobHtml() {
    const lines = job.items.map(itemLine).join('');
    const done = settled(job);
    return `<div class="sy-sec">${lines}${done ? '<div class="sy-line sy-dim">Their chats show here as they come down. A clone log is in Fleet View\'s data folder (clone.log).</div>' : ''}`
      + (done ? '<div class="sy-btns"><button type="button" data-cl="close">Close</button></div>' : '') + '</div>';
  }
  function draw() {
    if (!card) return;
    const body = job ? jobHtml() : askHtml();
    card.innerHTML = `<div class="uw-top"><span class="uw-title">${icon('repo', 14)}<b>Repos from your other machines</b></span>`
      + `<button type="button" class="uw-x" data-cl="hide" aria-label="close" title="close (Esc)">${icon('close', 13)}</button></div>`
      + `<div class="uw-scroll">${body}${note ? `<div class="sy-note${note.bad ? ' bad' : ''}">${esc(note.text)}</div>` : ''}</div>`
      + '<div class="uw-foot">They go where your other checkouts are. The Sync card can change that, or turn automatic cloning off.</div>';
  }
  async function watch(id) {
    for (;;) {
      if (!card || !job || job.id !== id) return;
      if (settled(job)) { draw(); return; }
      await new Promise((r) => setTimeout(r, JOB_MS));
      const { status, j } = await getJson(`/sync/clone?id=${encodeURIComponent(id)}`);
      if (!card || !job || job.id !== id) return;
      if (status === 200 && j) job = j;
      draw();
    }
  }
  async function onClick(ev) {
    const b = ev.target.closest('[data-cl]');
    if (!b || !card) return;
    const c = b.dataset.cl;
    if (c === 'hide') { hide(); return; }
    if (c === 'close') { close(); refresh(); return; }
    if (busy) return;
    if (c === 'notnow') {
      busy = true; draw();
      const r = await post('/sync/missing', { notNow: true });
      busy = false;
      if (r && r.ok) { view = r; close(); return; }
      note = { text: (r && r.message) || 'Fleet View did not answer.', bad: true };
      draw();
      return;
    }
    if (c === 'clone') {
      const boxes = [...card.querySelectorAll('input[data-o]')];
      const origins = boxes.filter((x) => x.checked).map((x) => x.dataset.o);
      const skip = boxes.filter((x) => !x.checked).map((x) => x.dataset.o);
      const folder = card.querySelector('.cl-folder')?.value.trim() || '';
      const auto = !!card.querySelector('.cl-auto')?.checked;
      if (!origins.length) {
        // nothing ticked: the answer is still worth keeping (auto, and the left-out repos)
        busy = true; draw();
        const r = await post('/sync/missing', { notNow: true, auto, ...(folder ? { folder } : {}) });
        busy = false;
        if (r && r.ok) { view = r; close(); return; }
        note = { text: (r && r.message) || 'Fleet View did not answer.', bad: true };
        draw();
        return;
      }
      busy = true; note = null; draw();
      const r = await post('/sync/clone', { origins, skip, auto, ...(folder ? { folder } : {}) });
      busy = false;
      if (r && r.ok && r.job) { job = r.job; draw(); watch(job.id); return; }
      if (r && r.ok) { close(); refresh(); return; }
      note = { text: (r && r.message) || 'Fleet View did not answer.', bad: true };
      draw();
    }
  }
  timer = setTimeout(refresh, FIRST_MS);
  return { refresh };
}

// ---------- the Sync card's "Repos" part ----------
export function cloneSection(el, { post, isRemote = () => false, fixture = false } = {}) {
  if (!el || fixture || isRemote()) { if (el) el.hidden = true; return { stop() {} }; }
  let view = null, timer = null, stopped = false, editing = false, busy = false, note = null;

  async function refresh() {
    clearTimeout(timer);
    if (stopped) return;
    const { status, j } = await getJson('/sync/missing');
    if (stopped) return;
    view = status === 200 && j && j.ok ? j : null;
    draw();
    timer = setTimeout(refresh, SECTION_MS);
  }
  function stateHtml(r) {
    if (r.state === 'cloning') return '<span class="uw-chip some">cloning…</span>';
    if (r.state === 'queued') return '<span class="uw-chip">waiting</span>';
    if (r.state === 'failed') return '<span class="uw-chip away">failed</span>';
    if (r.state === 'declined') return '<span class="uw-chip">left out</span>';
    return '';
  }
  function draw() {
    if (stopped) return;
    if (!view) { el.hidden = true; el.innerHTML = ''; return; }
    el.hidden = false;
    const v = view;
    let html = `<div class="sy-h">${icon('repo', 13)}<b>Repos</b></div>`;
    if (!v.at) html += '<div class="sy-line sy-dim">Not looked yet: the first sync round says which repos this machine lacks.</div>';
    else if (!v.repos.length) html += '<div class="sy-line sy-dim">Every repo with synced chats has a checkout here.</div>';
    else {
      html += `<div class="sy-line">${n(v.repos.length, 'repo has', 'repos have')} chats from your other machines but no checkout here:</div>`;
      html += v.repos.map((r) => {
        const can = !['cloning', 'queued'].includes(r.state);
        return `<div class="cl-row" title="${esc(r.origin)}"><span class="cl-name">${esc(r.name)}</span><span class="sy-dim">${esc(n(r.chats, 'chat', 'chats'))}</span>${stateHtml(r)}`
          + `${can ? `<button type="button" data-cl="one" data-o="${esc(r.origin)}"${busy ? ' disabled' : ''}>Clone</button>` : ''}</div>`
          + (r.state === 'failed' && r.message ? `<div class="sy-line sy-bad cl-why">${esc(r.message)}</div>` : '');
      }).join('');
    }
    const live = (v.jobs || []).filter((j) => !settled(j) || j.items.some((x) => x.install && ['failed', 'missing'].includes(x.install.state)) || j.items.some((x) => x.state === 'failed')).slice(0, 2);
    for (const j of live) html += `<div class="cl-job">${j.items.map(itemLine).join('')}</div>`;
    html += `<label class="cl-check"><input type="checkbox" class="cl-auto"${v.auto ? ' checked' : ''}${busy ? ' disabled' : ''}><span>Clone new repos automatically</span></label>`;
    if (editing) {
      html += `<div class="cl-field"><span class="sy-dim">Clones go in</span><input type="text" class="cl-folder" spellcheck="false" value="${esc(v.folder || '')}"></div>`
        + `<div class="sy-btns"><button type="button" data-cl="save"${busy ? ' disabled' : ''}>Save</button><button type="button" data-cl="cancel">Cancel</button>`
        + `${v.picked ? `<button type="button" data-cl="default"${busy ? ' disabled' : ''}>Use the default (${esc(v.defaultFolder || '')})</button>` : ''}</div>`;
    } else {
      html += `<div class="sy-line sy-dim cl-in">Clones go in <span class="cl-path">${esc(v.folder || '')}</span> <button type="button" data-cl="edit" class="cl-link">Change</button></div>`;
    }
    if (note) html += `<div class="sy-line ${note.bad ? 'sy-bad' : 'sy-dim'}">${esc(note.text)}</div>`;
    if (el._html === html) return;
    // a folder being typed survives a redraw (a clone moving on while Change is open)
    const typing = editing ? el.querySelector('.cl-folder') : null;
    const kept = typing ? { value: typing.value, focus: document.activeElement === typing } : null;
    el.innerHTML = html;
    el._html = html;
    if (kept) {
      const f = el.querySelector('.cl-folder');
      if (f) { f.value = kept.value; if (kept.focus) f.focus(); }
    }
  }
  async function act(url, body) {
    busy = true; note = null; draw();
    const r = await Promise.resolve(post(url, body)).catch(() => null);
    busy = false;
    if (!r || r.ok === false) note = { text: (r && r.message) || 'Fleet View did not answer.', bad: true };
    return r;
  }
  el.addEventListener('click', async (ev) => {
    const b = ev.target.closest('[data-cl]');
    if (!b || stopped) return;
    const c = b.dataset.cl;
    if (c === 'edit') { editing = true; el._html = null; draw(); el.querySelector('.cl-folder')?.focus(); return; }
    if (c === 'cancel') { editing = false; draw(); return; }
    if (busy) return;
    if (c === 'one') {
      const r = await act('/sync/clone', { origins: [b.dataset.o] });
      if (r && r.ok) note = { text: 'Cloning: its chats come here once it is done.' };
    } else if (c === 'save' || c === 'default') {
      const folder = c === 'default' ? '' : (el.querySelector('.cl-folder')?.value.trim() || '');
      const r = await act('/sync/missing', { folder });
      if (r && r.ok) { view = r; editing = false; }
    }
    refresh();
  });
  el.addEventListener('change', async (ev) => {
    const t = ev.target;
    if (!t.classList || !t.classList.contains('cl-auto') || busy || stopped) return;
    const r = await act('/sync/missing', { auto: !!t.checked });
    if (r && r.ok) view = r;
    refresh();
  });
  refresh();
  return { stop() { stopped = true; clearTimeout(timer); } };
}

// ---------- "Clone workspace to this machine" (the workspace's right-click menu) ----------
const foldRoot = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
export function cloneWorkspaceItem(repo) {
  if (!wsCtx || wsCtx.isRemote() || !repo || !repo.root) return null;
  const k = foldRoot(repo.root);
  const theirs = (Array.isArray(repo.sessions) ? repo.sessions : []).filter((s) => s && s.syncOwner && s.syncOwner.device && !s.syncOwner.moving && s.repo && foldRoot(s.repo.root) === k);
  if (!theirs.length) return null;
  const hosts = [...new Set(theirs.map((s) => s.syncOwner.name).filter(Boolean))];
  return {
    label: 'Clone workspace to this machine', icon: 'copy',
    note: `${n(theirs.length, 'chat', 'chats')} from ${hosts.join(' and ') || 'another computer'}`,
    run: () => openWorkspaceCard({ root: repo.root, name: repo.name || repo.root.split(/[\\/]/).filter(Boolean).pop() || repo.root, from: hosts.join(' and ') || 'the other computer' }),
  };
}
let wsCard = null; // { el, job, repo, note, gen }
const PHASE = { checkout: 'getting a checkout here…', waiting: 'waiting for its chats to come down…', work: 'bringing the work over…', chats: 'copying the chats…' };
function wsHtml(c) {
  const j = c.job;
  let body = '';
  if (!j) body = `<div class="sy-line sy-dim">Starting…</div>`;
  else {
    const co = j.checkout || {};
    if (co.message) body += `<div class="sy-line cl-item"><b>Checkout</b>: ${co.state === 'failed' ? `<span class="sy-bad">${esc(co.message)}</span>` : esc(co.message)}</div>`;
    for (const w of j.work || []) body += `<div class="sy-line cl-item"><b>${esc(w.name)}</b>: ${w.state === 'failed' ? `<span class="sy-warn">${esc(w.message)}</span>` : esc(w.message)}</div>`;
    const ch = j.chats || {};
    if (j.done && j.phase !== 'failed' && ch.total) {
      const got = ch.copied || [];
      body += `<div class="sy-line">${got.length ? `Copied ${n(got.length, 'chat', 'chats')} to this machine` : 'No new chats to copy'}${ch.already ? ` <span class="sy-dim">· ${esc(String(ch.already))} copied before</span>` : ''}</div>`;
      if (got.length) body += `<div class="sy-line sy-dim">${got.slice(0, 20).map((x) => esc(x.name)).join(' · ')}</div>`;
      for (const f of ch.failed || []) body += `<div class="sy-line cl-item"><b>${esc(f.name)}</b>: <span class="sy-warn">${esc(f.message)}</span></div>`;
    }
    if (!j.done) body += `<div class="sy-line sy-dim">${esc(PHASE[j.phase] || 'working…')}</div>`;
    if (j.phase === 'failed' && j.message !== co.message) body += `<div class="sy-line sy-bad">${esc(j.message || 'it did not go through')}</div>`;
    for (const t of j.notes || []) body += `<div class="sy-line sy-dim">${esc(t)}</div>`;
    if (j.done) body += '<div class="sy-btns"><button type="button" data-cl="ws-close">Close</button></div>';
  }
  return `<div class="uw-top"><span class="uw-title">${icon('copy', 14)}<b>Clone ${esc(c.repo.name)} to this machine</b></span>`
    + `<button type="button" class="uw-x" data-cl="ws-close" aria-label="close" title="close (Esc)">${icon('close', 13)}</button></div>`
    + `<div class="uw-scroll"><div class="sy-sec">${body}</div>${c.note ? `<div class="sy-note bad">${esc(c.note)}</div>` : ''}</div>`
    + `<div class="uw-foot">The copies are this machine's own: new work in them runs here. ${esc(c.repo.from)} keeps its chats as they are.</div>`;
}
function wsDraw() { if (wsCard) wsCard.el.innerHTML = wsHtml(wsCard); }
function wsClose() { if (!wsCard) return; wsCard.el.remove(); wsCard = null; }
async function openWorkspaceCard(repo) {
  wsClose();
  const el = document.createElement('div');
  el.className = 'uw-pop sy-pop cl-pop cw-pop';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', `Clone ${repo.name} to this machine`);
  el.tabIndex = -1;
  document.body.appendChild(el);
  const c = { el, job: null, repo, note: null };
  wsCard = c;
  el.addEventListener('click', (ev) => { if (ev.target.closest('[data-cl="ws-close"]')) wsClose(); });
  el.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); wsClose(); } });
  wsDraw();
  el.focus();
  const r = await Promise.resolve(wsCtx.post('/sync/clone-workspace', { repo: repo.root })).catch(() => null);
  if (wsCard !== c) return;
  if (!r || !r.ok || !r.job) { c.job = { done: true, phase: 'failed', checkout: {}, message: (r && r.message) || 'Fleet View did not answer.', notes: [] }; wsDraw(); return; }
  c.job = r.job;
  wsDraw();
  while (wsCard === c && !c.job.done) {
    await new Promise((res) => setTimeout(res, JOB_MS));
    const { status, j } = await getJson(`/sync/clone-workspace?id=${encodeURIComponent(c.job.id)}`);
    if (wsCard !== c) return;
    if (status === 200 && j) c.job = j;
    else if (status === 404) { c.job = { ...c.job, done: true }; c.note = 'Fleet View restarted meanwhile: what was copied stays; clone it again for the rest.'; }
    wsDraw();
  }
}
