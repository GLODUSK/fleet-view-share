// Projects view: Claude Code's own layout. On the left, every listed repo with its conversations under it
// (live ones first, then the recently finished, then "Older" from the repo's history); on the right, the picked
// conversation as a chat (chat.js, the same pane and chat box as the panel's Chat tab).
//
// The pick is the shell's ui.selectedId while the conversation is in /state; an older one from the history
// (not in /state) is kept here as a stand-in { id, name, account, cwd, repo, state: 'DONE' }, so its chat still
// reads from its log and the chat box can continue it. The detail panel stays shut in this view unless its
// Session or Details button asks for it (ui.panel). Ctrl+click and Shift+click on rows build the shell's
// multi-selection; right-click on one of them opens its "N conversations" menu. The picked id and the folded repos are kept in this window's
// storage. Keys: ↑↓ (or j/k) move through the list, Enter puts the cursor in the chat box.
import { C, esc, setHTML, setIcon, badge, acctTag, ago, statusColor, isBusy, needsYou, repoChip, branchChip } from './cards.js';
import { icon } from './icons.js';
import { renderChatPane } from './chat.js';
import { onRekey } from './term.js';

const OLDER_SHOW = 8; // older conversations listed before "Show all"
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const folded = new Set(store.get('fv.projects.folded', []));
let selId = store.get('fv.projects.sel', null);
let selLast = null; // the last copy of the picked conversation, kept if it leaves the lists
const older = new Map(); // repo root -> { at, items, loading, all, open }
let pane = null;

onRekey((oldKey, id) => { if (selId === oldKey) { selId = id; store.set('fv.projects.sel', id); } });

const rootOf = (s) => (s && s.repo && s.repo.root) || '';
const lastOf = (s) => s.last || s.endedAt || s.lastActive || 0;
// minutes only, so the list is not rewritten every second (a click mid-rewrite would be lost)
const coarseAgo = (ms) => (ms < 60e3 ? 'now' : ago(ms));

function loadOlder(root, ui) {
  const o = older.get(root) || { items: [], open: false, all: false };
  older.set(root, o);
  if (o.loading || (o.at && Date.now() - o.at < 60e3)) return;
  o.loading = true;
  fetch(`/repo-history?root=${encodeURIComponent(root)}`, { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : null)).catch(() => null)
    .then((j) => {
      o.loading = false; o.at = Date.now();
      o.items = (j && Array.isArray(j.items) ? j.items : []).filter((h) => h && typeof h.id === 'string');
      o.indexing = !!(j && j.indexing);
      ui.refresh();
    });
}

// the repos and what is under each, in the shell's repo order; conversations whose repo isn't listed go last
function groups(state) {
  const live = (state.sessions || []).concat(state.pending || []);
  const done = (state.finishedSessions || []).filter((s) => !live.some((x) => x.id === s.id));
  const out = (state.repoAnchors || []).map((r) => ({ root: r.root, name: r.name, color: r.color, live: [], done: [] }));
  const byRoot = new Map(out.map((g) => [g.root, g]));
  let other = null;
  const put = (s, k) => {
    let g = byRoot.get(rootOf(s));
    if (!g) {
      if (!other) other = { root: '', name: 'no repo', color: C.dim, live: [], done: [] };
      g = other;
    }
    g[k].push(s);
  };
  for (const s of live) put(s, 'live');
  for (const s of done) put(s, 'done');
  for (const g of out) g.done.sort((a, b) => lastOf(b) - lastOf(a));
  if (other) out.push(other);
  return out;
}

function row(s, now, picked, ui, extra = '') {
  const here = ui.isHosted && ui.isHosted(s.id);
  const busy = isBusy(s.state);
  return `<button type="button" class="pj-row${picked ? ' on' : ''}${s.state === 'DONE' ? ' done' : ''}${needsYou(s.state) ? ' needs' : ''}" data-pick="${esc(s.id)}" data-id="${esc(s.id)}" style="--status:${esc(statusColor(s))}" title="${esc(s.goal || s.name || '')}">`
    + `<span class="pj-ic" data-ic="${esc(s.id)}"></span>`
    + `<span class="pj-name">${esc(s.name || String(s.id).slice(0, 8))}</span>`
    + `${here ? `<span class="pj-here" title="running here, in Fleet View">${icon('shell', 11)}</span>` : ''}`
    + `${extra}${acctTag(s.account)}<span class="pj-ago${busy ? ' busy' : ''}">${s.pending ? 'new' : coarseAgo(now - lastOf(s))}</span></button>`;
}

function olderRow(h, now, picked) {
  return `<button type="button" class="pj-row done old${picked ? ' on' : ''}" data-old="${esc(h.id)}" title="${esc(h.name || h.id)}">`
    + `<span class="pj-ic">${icon('clock', 13)}</span><span class="pj-name">${esc(h.name || h.id.slice(0, 8))}</span>`
    + `${h.removed ? '<span class="pj-tag">removed</span>' : ''}${acctTag(h.account === 'A' || h.account === 'B' ? h.account : '')}`
    + `<span class="pj-ago">${h.lastActive ? coarseAgo(now - h.lastActive) : ''}</span></button>`;
}

function sideHtml(gs, now, ui) {
  if (!gs.length) return `<div class="pj-none">No repos listed. Right-click here to add one.</div>`;
  return gs.map((g) => {
    const shut = folded.has(g.root);
    const n = g.live.length;
    const head = `<div class="pj-repo${shut ? ' shut' : ''}" data-root="${esc(g.root)}">`
      + `<button type="button" class="pj-repo-h" data-fold="${esc(g.root)}" aria-expanded="${!shut}" title="${esc(g.root || 'conversations outside any repo')}">`
      + `<span class="pj-chev">${icon('chevron', 12)}</span><span class="pj-dia" style="background:${esc(g.color || C.dim)}"></span>`
      + `<span class="pj-repo-n">${esc(g.name)}</span>${n ? `<span class="pj-count">${n}</span>` : ''}</button>`
      + (g.root ? `<button type="button" class="pj-new" data-new="${esc(g.root)}" title="New session in ${esc(g.name)}">${icon('plus', 13)}</button>` : '')
      + `</div>`;
    if (shut) return `<section class="pj-group">${head}</section>`;
    const shown = new Set(g.live.concat(g.done).map((s) => s.id));
    let body = g.live.map((s) => row(s, now, s.id === selId, ui)).join('')
      + g.done.map((s) => row(s, now, s.id === selId, ui)).join('');
    if (!body) body = '<div class="pj-empty">no live conversations</div>';
    if (g.root) {
      const o = older.get(g.root);
      if (o && o.open) {
        const items = (o.items || []).filter((h) => !shown.has(h.id));
        const list = o.all ? items : items.slice(0, OLDER_SHOW);
        body += `<div class="pj-sub">Older</div>`
          + (list.length ? list.map((h) => olderRow(h, now, h.id === selId)).join('') : `<div class="pj-empty">${o.loading || o.indexing ? 'loading…' : 'no older conversations'}</div>`)
          + (!o.all && items.length > OLDER_SHOW ? `<button type="button" class="pj-more" data-all="${esc(g.root)}">Show all ${items.length}</button>` : '')
          + `<button type="button" class="pj-more" data-older="${esc(g.root)}">Hide older</button>`;
      } else body += `<button type="button" class="pj-more" data-older="${esc(g.root)}">${icon('clock', 12)}<span>Older conversations</span></button>`;
    }
    return `<section class="pj-group">${head}<div class="pj-list">${body}</div></section>`;
  }).join('');
}

// the picked conversation: from the lists, else an older one's stand-in, else its last copy
function picked(state) {
  if (!selId) return null;
  const all = (state.allSessions || []).concat(state.finishedSessions || []);
  const s = all.find((x) => x.id === selId);
  if (s) return s;
  for (const o of older.values()) {
    const h = (o.items || []).find((x) => x.id === selId);
    if (h) return { id: h.id, name: h.name || h.id.slice(0, 8), account: h.account === 'A' ? 'A' : 'B', cwd: h.cwd || null, repo: h.repo || null, state: 'DONE', label: 'OLDER', last: h.lastActive || 0, past: true };
  }
  return selLast && selLast.id === selId ? selLast : null;
}

function pick(id, ui, state) {
  selId = id;
  store.set('fv.projects.sel', id);
  // the shell's pick follows, so Enter, the right-click menu and the other views agree; the panel stays shut
  const inState = (state.allSessions || []).some((x) => x.id === id);
  ui.selectedId = inState ? id : null;
  ui.refresh();
  requestAnimationFrame(() => pane?._side?.querySelector('.pj-row.on')?.scrollIntoView({ block: 'nearest' }));
}

function build(el, ui) {
  el.innerHTML = `<div class="pj"><nav class="pj-side" aria-label="repos and conversations"></nav>
<section class="pj-main"><header class="pj-top" hidden><span class="c-icon pj-top-ic"></span><div class="pj-top-t"></div><div class="pj-top-b"></div></header>
<div class="pj-chat"></div><div class="pj-blank empty">Pick a conversation on the left to see it here.</div></section></div>`;
  el._side = el.querySelector('.pj-side');
  el._top = el.querySelector('.pj-top');
  el._topIc = el.querySelector('.pj-top-ic');
  el._topT = el.querySelector('.pj-top-t');
  el._topB = el.querySelector('.pj-top-b');
  el._chat = el.querySelector('.pj-chat');
  el._blank = el.querySelector('.pj-blank');
  el._built = true;
  pane = el;
  el._side.addEventListener('click', (e) => {
    const t = e.target.closest('button');
    if (!t || e.target.closest('[data-act]')) return;
    const st = el._state;
    // Ctrl+click adds a conversation to the multi-selection or takes it out; Shift+click takes the rows from the
    // picked one to this one. Right-click on one of them then opens the "N conversations" menu (Remove all, …).
    if (t.dataset.pick && (e.ctrlKey || e.metaKey) && ui.toggleMulti) { e.preventDefault(); ui.toggleMulti(t.dataset.pick); return; }
    if (t.dataset.pick && e.shiftKey && ui.selectMany) {
      e.preventDefault();
      const ids = [...el._side.querySelectorAll('[data-pick]')].map((b) => b.dataset.pick);
      const from = ids.indexOf(selId), to = ids.indexOf(t.dataset.pick);
      ui.selectMany(from < 0 ? [t.dataset.pick] : ids.slice(Math.min(from, to), Math.max(from, to) + 1));
      return;
    }
    if ((t.dataset.pick || t.dataset.old) && ui.multi?.length && ui.clearMulti) ui.clearMulti();
    // a click on a conversation also puts the keyboard in its chat box, ready to type
    if (t.dataset.pick) { pick(t.dataset.pick, ui, st); focusCompose(el); }
    else if (t.dataset.old) { pick(t.dataset.old, ui, st); focusCompose(el); }
    else if (t.dataset.fold != null) {
      const r = t.dataset.fold;
      if (folded.has(r)) folded.delete(r); else folded.add(r);
      store.set('fv.projects.folded', [...folded]);
      ui.refresh();
    } else if (t.dataset.older) {
      const r = t.dataset.older, o = older.get(r) || { items: [] };
      o.open = !o.open; o.all = false;
      older.set(r, o);
      if (o.open) loadOlder(r, ui);
      ui.refresh();
    } else if (t.dataset.all) { const o = older.get(t.dataset.all); if (o) o.all = true; ui.refresh(); }
    else if (t.dataset.new) {
      // the repo's own menu: New session · A / B, and the rest
      const b = t.getBoundingClientRect();
      ui.contextMenu({ kind: 'repo', root: t.dataset.new }, b.left, b.bottom + 4);
    }
  });
  el._side.addEventListener('dblclick', (e) => {
    const t = e.target.closest('[data-pick]');
    if (t) { e.preventDefault(); focusCompose(el); }
  });
  el._side.addEventListener('contextmenu', (e) => {
    const r = e.target.closest('.pj-repo[data-root]');
    if (r && r.dataset.root) { e.preventDefault(); ui.contextMenu({ kind: 'repo', root: r.dataset.root }, e.clientX, e.clientY); return; }
    const t = e.target.closest('[data-pick]');
    if (!t || !(el._state.allSessions || []).some((x) => x.id === t.dataset.pick)) return;
    e.preventDefault();
    const m = ui.multi || [];
    ui.contextMenu(m.length >= 2 && m.includes(t.dataset.pick) ? { kind: 'sessions', ids: m } : { kind: 'session', id: t.dataset.pick }, e.clientX, e.clientY);
  });
  el._topB.addEventListener('click', (e) => {
    const b = e.target.closest('[data-pane]');
    if (!b || !selId) return;
    if (b.dataset.pane === 'terminal') ui.openTerminal(selId);
    else ui.panel(selId, b.dataset.pane);
  });
  ui.keys.projects = (e) => {
    const k = e.key;
    if (k === 'Enter' || k === 'o') { if (!selId) return false; focusCompose(el); return true; }
    const d = k === 'ArrowDown' || k === 'j' ? 1 : k === 'ArrowUp' || k === 'k' ? -1 : 0;
    if (!d) return false;
    const ids = [...el._side.querySelectorAll('[data-pick], [data-old]')].map((b) => b.dataset.pick || b.dataset.old);
    if (!ids.length) return true;
    const i = ids.indexOf(selId);
    pick(ids[i < 0 ? 0 : Math.max(0, Math.min(ids.length - 1, i + d))], ui, el._state);
    return true;
  };
}
const focusCompose = (el) => requestAnimationFrame(() => el._chat.querySelector('.chat-compose textarea')?.focus());

export function renderProjects(el, state, ui) {
  if (!el._built) build(el, ui);
  el._state = state;
  const now = Date.now();
  // a pick made in another view (a card, the map) carries over
  if (ui.selectedId && ui.selectedId !== selId) { selId = ui.selectedId; store.set('fv.projects.sel', selId); }
  const gs = groups(state);
  // the list is rebuilt only when what it shows changes; the status icons are patched in place
  setHTML(el._side, sideHtml(gs, now, ui));
  const all = gs.flatMap((g) => g.live.concat(g.done));
  for (const ic of el._side.querySelectorAll('[data-ic]')) {
    const s = all.find((x) => x.id === ic.dataset.ic);
    if (s) setIcon(ic, s);
  }
  const s = picked(state);
  if (s && !s.past) selLast = s;
  el._top.hidden = !s;
  el._chat.hidden = !s;
  el._blank.hidden = !!s;
  if (!s) return;
  el.style.setProperty('--hue', s.hue || C.cyan);
  setIcon(el._topIc, s);
  setHTML(el._topT, `<div class="pj-top-n"><span class="name">${esc(s.name)}</span>${acctTag(s.account)}${badge(s)}</div>`
    + `<div class="pj-top-m">${repoChip(s)}${s.branch ? branchChip(s) : ''}${s.goal ? `<span class="pj-goal" title="${esc(s.goal)}">${esc(s.goal)}</span>` : ''}</div>`);
  const inState = !s.past && (state.allSessions || []).some((x) => x.id === s.id);
  setHTML(el._topB, (inState ? `<button type="button" class="btn" data-pane="session" title="the live session, in the side panel">${icon('shell', 14)}<span>Session</span></button>`
    + `<button type="button" class="btn" data-pane="details" title="plan, ship track, files and cost, in the side panel">${icon('info', 14)}<span>Details</span></button>` : '')
    + `<button type="button" class="btn" data-pane="terminal" title="open it in Windows Terminal">${icon('open', 14)}<span>Terminal</span></button>`);
  renderChatPane(el._chat, s, { visible: true });
}
