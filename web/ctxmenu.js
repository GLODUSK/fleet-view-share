// Fleet View web: the right-click menu (repos, conversations, empty space; app.js decides what it lists).
//
//   openCtxMenu({ x, y, title, dot, sub, items })   opens at the pointer (client px), kept on screen
//     title / sub: a heading line (the repo or conversation) and a quieter line under it; dot: its colour
//     items: [{ label, icon?, run(), disabled?, note?, tag?, danger?, confirm?: { text, yes }, children? } | { sep: true }]
//       disabled items are a quiet line that can't be picked (note: why); confirm turns the menu into a small
//       question ("yes" runs it, Cancel goes back) before run() is called; tag: 'A' or 'B', the account tag
//       on the right; children: the items of a submenu (same shape; a confirm there turns the main menu into the question),
//       shown with a ▸ and opened to the side as a second frosted menu (an input item works there too, and
//       turns the main menu into its box; a submenu item with children of its own opens them in the submenu's
//       place, under a back row: ← or Esc or the back row returns); load(): instead of children, a function
//       resolving to them, called when the submenu first opens (it shows "loading…" until then); badge: a small
//       word on the right ("removed"); input: { placeholder, hint?, submit(text), alt?: { label, run() } }
//       turns the menu into a one-line text box under the item's label: Enter calls submit(text), which returns
//       (or resolves to) null when it worked (the menu closes) or a message to show under the box, in red (it
//       stays); Esc closes; alt adds a small link beside the message (the desktop window's "Browse").
//       More input fields: value (the box starts with this text, the caret at its end), multiline (a few lines tall:
//       Enter sends, Shift+Enter starts a new line; for orders and notes), empty (what it says when Enter
//       finds the box empty), busy (what it says while submit runs, e.g. "sending…"), allowEmpty (Enter on an
//       empty box calls submit('') instead: Rename, where empty goes back to Claude Code's own title)
//       stay (a submenu item): picking it runs it and keeps the menu open; the parent item's refresh() returns
//       the parent item anew (label, badge, children) to redraw both menus with (toggles: Accounts ▸ ✓ A)
//   closeCtxMenu()   ctxMenuOpen()
//
// Frosted like the repo menu (same .menu surface and tokens). Keys while it is open: ↑↓ (and Home / End)
// move, Enter or Space picks, Esc closes; on an item with a submenu → (or Enter) opens it and moves into it,
// ← or Esc goes back. Hovering such an item opens its submenu, which opens to the right of the menu (to
// the left when there is no room) and stays on screen; a long one scrolls. No other shortcut fires. It
// closes on a click or a wheel outside it, a scroll, a resize, the window losing focus, and when an item
// runs. Nothing in it pulses or flashes: it drops in once (180 ms) like the repo menu.
import { esc, acctTag } from './cards.js';
import { icon } from './icons.js';

let el = null, items = [], sel = -1, open = false, prevFocus = null, confirmFor = null, spec = null, inputFor = null, inputBusy = false;
// the submenu: its element, the parent item's index, its items and pick; level: where the keys go
let subEl = null, subOf = -1, subItems = [], subSel = -1, level = 'main';
// a submenu opened inside the submenu (drilled into): the levels above it, each { items, sel }
let subStack = [];

function ensure() {
  if (el) return el;
  el = document.createElement('div');
  el.id = 'ctx-menu';
  el.className = 'menu ctx-menu';
  el.setAttribute('role', 'menu');
  el.tabIndex = -1;
  el.hidden = true;
  document.body.appendChild(el);
  subEl = document.createElement('div');
  subEl.id = 'ctx-sub';
  subEl.className = 'menu ctx-menu ctx-submenu';
  subEl.setAttribute('role', 'menu');
  subEl.hidden = true;
  document.body.appendChild(subEl);
  for (const box of [el, subEl]) {
    box.addEventListener('pointerdown', (e) => e.stopPropagation());
    // keep focus on the menu (a press in the text box places the caret as usual)
    box.addEventListener('mousedown', (e) => { e.stopPropagation(); if (e.button === 0 && !e.target.closest('.ctx-input')) e.preventDefault(); });
    box.addEventListener('contextmenu', (e) => { if (!e.target.closest('.ctx-input')) e.preventDefault(); e.stopPropagation(); }); // the box keeps the browser's own (paste)
  }
  el.addEventListener('click', (e) => {
    e.stopPropagation();
    if (inputFor && e.target.closest('.ctx-in-alt')) {
      const alt = inputFor.input.alt;
      closeCtxMenu();
      try { alt && alt.run && alt.run(); } catch (err) { console.error(err); }
      return;
    }
    const row = e.target.closest('[data-i]');
    if (row) pick(+row.dataset.i);
  });
  el.addEventListener('mousemove', (e) => {
    const row = e.target.closest('[data-i]');
    if (!row || !pickable(+row.dataset.i)) return;
    const i = +row.dataset.i;
    if (i !== sel || level !== 'main') { sel = i; level = 'main'; subSel = -1; mark(); }
    // hovering an item with a submenu opens it; any other item closes it
    if (hasKids(items[i])) { if (subOf !== i) openSub(i, false); else markSub(); }
    else if (subOf >= 0) closeSub();
  });
  subEl.addEventListener('click', (e) => {
    e.stopPropagation();
    const row = e.target.closest('[data-j]');
    if (row) pickSub(+row.dataset.j);
  });
  subEl.addEventListener('mousemove', (e) => {
    const row = e.target.closest('[data-j]');
    if (!row || !subPickable(+row.dataset.j)) return;
    const j = +row.dataset.j;
    if (j !== subSel || level !== 'sub') { subSel = j; level = 'sub'; markSub(); }
  });
  return el;
}

const hasKids = (it) => !!it && ((Array.isArray(it.children) && it.children.length > 0) || typeof it.load === 'function');
const pickable = (i) => !!items[i] && !items[i].sep && !items[i].disabled;
const subPickable = (j) => !!subItems[j] && !subItems[j].sep && !subItems[j].disabled;

function rowHtml(it, i, attr = 'data-i', on = i === sel) {
  if (it.sep) return '<div class="ctx-sep" role="separator"></div>';
  const ic = it.icon ? icon(it.icon, 15) : '';
  const kids = hasKids(it);
  const tail = (it.badge ? `<span class="ctx-badge">${esc(it.badge)}</span>` : '') + (it.tag ? acctTag(it.tag) : '') + (kids ? `<span class="ctx-more" aria-hidden="true">${icon('chevron', 13) || '▸'}</span>` : '');
  const cls = `menu-item ctx-item${it.disabled ? ' off' : ''}${it.danger ? ' danger' : ''}${tail ? ' has-tail' : ''}${kids ? ' has-sub' : ''}${on ? ' sel' : ''}`;
  return `<div class="${cls}" ${attr}="${i}" role="menuitem"${it.disabled ? ' aria-disabled="true"' : ''}${kids ? ` aria-haspopup="menu" aria-expanded="${subOf === i}"` : ''}>`
    + `<span class="ctx-ic" aria-hidden="true">${ic}</span><span class="ctx-l">${esc(it.label)}`
    + `${it.note ? `<span class="ctx-note">${esc(it.note)}</span>` : ''}</span>${tail ? `<span class="ctx-tail">${tail}</span>` : ''}</div>`;
}

function draw() {
  if (inputFor) {
    const inp = inputFor.input;
    const box = inp.multiline
      ? `<textarea class="ctx-input path-input ctx-area" rows="4" spellcheck="true" placeholder="${esc(inp.placeholder || '')}" aria-label="${esc(inputFor.label)}"></textarea>`
      : `<input class="ctx-input path-input" type="text" spellcheck="false" autocomplete="off" placeholder="${esc(inp.placeholder || '')}" aria-label="${esc(inputFor.label)}">`;
    el.innerHTML = `<div class="ctx-head ctx-q">${esc(inputFor.label)}</div>`
      + `<div class="ctx-in-wrap">${box}</div>`
      + `<div class="ctx-in-foot"><div class="ctx-in-msg" aria-live="polite">${esc(inp.hint || 'Enter adds · Esc closes')}</div>`
      + `${inp.alt ? `<button type="button" class="ctx-in-alt link-btn" tabindex="-1">${esc(inp.alt.label)}</button>` : ''}</div>`;
    el.classList.remove('confirming');
    el.classList.add('inputting');
    el.classList.toggle('inputting-wide', !!inp.multiline);
    const b = el.querySelector('.ctx-input');
    if (b && inp.value) b.value = String(inp.value);
    return;
  }
  el.classList.remove('inputting', 'inputting-wide');
  const head = confirmFor
    ? `<div class="ctx-head ctx-q">${esc(confirmFor.confirm.text)}</div>`
    : spec.title ? `<div class="ctx-head"><span class="ctx-title">${spec.dot ? `<span class="dot" style="background:${esc(spec.dot)}"></span>` : ''}<span class="ctx-name">${esc(spec.title)}</span></span>`
      + `${spec.sub ? `<span class="ctx-sub">${esc(spec.sub)}</span>` : ''}</div>` : '';
  el.innerHTML = head + items.map((it, i) => rowHtml(it, i)).join('');
  el.classList.toggle('confirming', !!confirmFor);
}
function mark() {
  for (const r of el.querySelectorAll('[data-i]')) {
    const i = +r.dataset.i;
    r.classList.toggle('sel', i === sel);
    if (r.classList.contains('has-sub')) r.setAttribute('aria-expanded', String(subOf === i));
  }
}
function markSub() {
  for (const r of subEl.querySelectorAll('[data-j]')) r.classList.toggle('sel', +r.dataset.j === subSel && level === 'sub');
}

// keep it on screen: flip left / up when it would leave the window, then clamp
function place(x, y) {
  el.style.left = '0px'; el.style.top = '0px';
  const w = el.offsetWidth, h = el.offsetHeight, W = window.innerWidth, H = window.innerHeight, m = 8;
  let left = x + 2, top = y + 2;
  if (left + w > W - m) left = x - w - 2;
  if (top + h > H - m) top = y - h - 2;
  left = Math.max(m, Math.min(left, W - w - m));
  top = Math.max(m, Math.min(top, H - h - m));
  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(top)}px`;
}

// ---------- the submenu ----------
function openSub(i, focus) {
  const it = items[i];
  if (!hasKids(it)) return;
  subOf = i;
  subStack = [];
  if (Array.isArray(it.children)) subItems = it.children.filter(Boolean);
  else { subItems = [{ label: 'loading…', icon: 'clock', disabled: true }]; loadKids(it, i); }
  subSel = focus ? subItems.findIndex((_, j) => subPickable(j)) : -1;
  level = focus ? 'sub' : 'main';
  subEl.innerHTML = subItems.map((c, j) => rowHtml(c, j, 'data-j', j === subSel)).join('');
  subEl.scrollTop = 0;
  subEl.hidden = false;
  placeSub();
  mark();
  markSub();
  scrollSubTo(subSel);
}
// a submenu given as load(): fetched once per opening of the menu, then drawn in place of "loading…"
function loadKids(it, i) {
  if (it._loading) return;
  it._loading = true;
  Promise.resolve().then(() => it.load()).catch(() => null).then((kids) => {
    it._loading = false;
    const list = Array.isArray(kids) ? kids.filter(Boolean) : [];
    it.children = list.length ? list : [{ label: 'nothing to show', icon: 'info', disabled: true }];
    if (open && items[i] === it && subOf === i) openSub(i, level === 'sub');
  });
}
// beside its row: to the right of the menu, or to the left when there is no room; clamped to the window
function placeSub() {
  const row = el.querySelector(`[data-i="${subOf}"]`);
  if (!row) return;
  subEl.style.left = '0px'; subEl.style.top = '0px';
  const m = 8, W = window.innerWidth, H = window.innerHeight;
  const box = el.getBoundingClientRect(), r = row.getBoundingClientRect();
  const w = subEl.offsetWidth, h = Math.min(subEl.offsetHeight, H - 2 * m);
  let left = box.right - 2;
  if (left + w > W - m) left = box.left - w + 2;
  left = Math.max(m, Math.min(left, W - w - m));
  let top = r.top - 7;
  top = Math.max(m, Math.min(top, H - h - m));
  subEl.style.left = `${Math.round(left)}px`;
  subEl.style.top = `${Math.round(top)}px`;
}
function closeSub() {
  if (!subEl || subOf < 0) return;
  subOf = -1; subItems = []; subSel = -1; level = 'main'; subStack = [];
  subEl.hidden = true;
  subEl.innerHTML = '';
  mark();
}
function scrollSubTo(j) {
  const r = j >= 0 ? subEl.querySelector(`[data-j="${j}"]`) : null;
  if (r) r.scrollIntoView({ block: 'nearest' });
}
function drawSub() {
  subEl.innerHTML = subItems.map((c, k) => rowHtml(c, k, 'data-j', k === subSel)).join('');
  subEl.scrollTop = 0;
  placeSub();
  markSub();
  scrollSubTo(subSel);
}
// into a submenu item's own children (they take the submenu's place), and back out
const drillable = (it) => !!it && Array.isArray(it.children) && it.children.length > 0;
function drillIn(j) {
  const it = subItems[j];
  subStack.push({ items: subItems, sel: j });
  subItems = [{ label: it.label, icon: 'reply', back: true }, { sep: true }, ...it.children.filter(Boolean)];
  subSel = subItems.findIndex((c, k) => k > 0 && subPickable(k));
  level = 'sub';
  drawSub();
}
function drillOut() {
  const up = subStack.pop();
  if (!up) return false;
  subItems = up.items;
  subSel = up.sel;
  level = 'sub';
  drawSub();
  return true;
}
function pickSub(j) {
  if (!subPickable(j)) return;
  const it = subItems[j];
  if (it.back) { drillOut(); return; }
  if (drillable(it)) { drillIn(j); return; }
  // "Show N more" (more: the rest of the list): the rest in its place, and the menu stays open
  if (Array.isArray(it.more)) {
    subItems = [...subItems.slice(0, j), ...it.more.filter(Boolean), ...subItems.slice(j + 1)];
    if (items[subOf] && !subStack.length) items[subOf].children = subItems;
    subSel = j;
    level = 'sub';
    subEl.innerHTML = subItems.map((c, k) => rowHtml(c, k, 'data-j', k === subSel)).join('');
    placeSub();
    markSub();
    scrollSubTo(subSel);
    return;
  }
  if (it.input) { startInput(it); return; }
  // confirm: like a main-menu item, the menu becomes the question (Send elsewhere ▸ Claude C, mid-turn)
  if (it.confirm) { pick(-1, it); return; }
  // stay: a toggle (Accounts ▸ ✓ A): it runs and the menu stays open, redrawn from the parent's refresh()
  if (it.stay) {
    keepUntil = Date.now() + 2500; // the page redraws (cards come and go) and may scroll: not a reason to close
    try { it.run && it.run(); } catch (e) { console.error(e); }
    const p = items[subOf];
    if (p && typeof p.refresh === 'function' && !subStack.length) {
      const next = p.refresh();
      if (next && Array.isArray(next.children)) {
        items[subOf] = next;
        draw();
        mark();
        subItems = next.children.filter(Boolean);
        subSel = j;
        level = 'sub';
        drawSub();
      }
    }
    return;
  }
  closeCtxMenu();
  try { it.run && it.run(); } catch (e) { console.error(e); }
}

export function openCtxMenu(o) {
  ensure();
  if (open) closeCtxMenu(false);
  openSize = winSize();
  spec = { ...o };
  items = (o.items || []).filter(Boolean);
  confirmFor = null; inputFor = null; inputBusy = false;
  subOf = -1; level = 'main';
  sel = items.findIndex((_, i) => pickable(i));
  prevFocus = document.activeElement;
  open = true;
  el.hidden = false;
  draw();
  spec.x = o.x; spec.y = o.y;
  place(o.x, o.y);
  try { el.focus({ preventScroll: true }); } catch {}
  return el;
}

export function closeCtxMenu(restore = true) {
  if (!open) return;
  open = false;
  confirmFor = null; inputFor = null; inputBusy = false;
  el.classList.remove('inputting', 'inputting-wide');
  closeSub();
  el.hidden = true;
  el.innerHTML = '';
  // give the keyboard back to where it was (the terminal, a card), unless something else took it meanwhile
  const back = prevFocus;
  prevFocus = null;
  if (restore && back && back.isConnected && back !== document.body && (document.activeElement === el || document.activeElement === document.body)) {
    try { back.focus({ preventScroll: true }); } catch {}
  } else if (document.activeElement === el) el.blur();
}

export const ctxMenuOpen = () => open;

function pick(i, sub = null) {
  if (!sub && !pickable(i)) return;
  const it = sub || items[i];
  if (hasKids(it)) { sel = i; openSub(i, true); return; }
  if (it.confirm && !confirmFor) {
    // a question first: the menu becomes "<text>" with the action and Cancel (Cancel picked)
    closeSub();
    confirmFor = it;
    items = [{ label: it.confirm.yes || it.label, icon: it.icon, danger: true, run: it.run, confirmed: true }, { label: 'Cancel', icon: 'close', cancel: true }];
    sel = 1;
    draw();
    place(spec.x, spec.y);
    return;
  }
  if (it.input) { startInput(it); return; }
  if (it.cancel) { closeCtxMenu(); return; }
  closeCtxMenu();
  try { it.run && it.run(); } catch (e) { console.error(e); }
}

// the menu becomes a text box (an "input" item); the keyboard goes to the box
function startInput(it) {
  closeSub();
  inputFor = it;
  draw();
  place(spec.x, spec.y);
  const box = el.querySelector('.ctx-input');
  if (box) { try { box.focus({ preventScroll: true }); if (box.value) box.setSelectionRange(box.value.length, box.value.length); } catch {} }
}
async function submitInput() {
  const box = el.querySelector('.ctx-input'), msg = el.querySelector('.ctx-in-msg');
  if (!inputFor || !box || inputBusy) return;
  const text = box.value.trim();
  const it = inputFor;
  if (!text && !it.input.allowEmpty) { if (msg) msg.textContent = it.input.empty || 'paste or type a folder path first'; return; }
  inputBusy = true;
  if (msg) { msg.textContent = it.input.busy || 'adding…'; msg.classList.remove('err'); }
  let err = null;
  try { err = await it.input.submit(text); } catch (e) { err = (e && e.message) || 'that did not work'; }
  inputBusy = false;
  if (!open || inputFor !== it) return;
  if (!err) { closeCtxMenu(); return; }
  if (msg) { msg.textContent = String(err); msg.classList.add('err'); }
  try { box.focus({ preventScroll: true }); } catch {}
}

function move(d) {
  if (level === 'sub') {
    if (!subItems.some((_, j) => subPickable(j))) return;
    let j = subSel;
    for (let n = 0; n < subItems.length; n++) {
      j = (j + d + subItems.length) % subItems.length;
      if (subPickable(j)) break;
    }
    subSel = j;
    markSub();
    scrollSubTo(j);
    return;
  }
  if (!items.some((_, i) => pickable(i))) return;
  let i = sel;
  for (let n = 0; n < items.length; n++) {
    i = (i + d + items.length) % items.length;
    if (pickable(i)) break;
  }
  sel = i;
  if (subOf >= 0 && subOf !== i) closeSub();
  mark();
}
function ends(k) {
  const list = level === 'sub' ? subItems : items, ok = level === 'sub' ? subPickable : pickable;
  const idx = list.map((_, i) => i).filter(ok);
  if (!idx.length) return;
  const to = k === 'Home' ? idx[0] : idx[idx.length - 1];
  if (level === 'sub') { subSel = to; markSub(); scrollSubTo(to); } else { sel = to; if (subOf >= 0 && subOf !== to) closeSub(); mark(); }
}

// keys go to the menu first (capture), and none of them reaches the page's shortcuts while it is open
document.addEventListener('keydown', (e) => {
  if (!open) return;
  const k = e.key;
  e.stopPropagation();
  if (inputFor) {
    // typing, paste and the caret keys are the text box's own (none reaches the page's shortcuts)
    if (k === 'Escape') { e.preventDefault(); closeCtxMenu(); }
    else if (k === 'Enter' && !(e.shiftKey && inputFor.input.multiline)) { e.preventDefault(); submitInput(); }
    else if (k === 'Tab') e.preventDefault();
    return;
  }
  if (k === 'Escape') {
    e.preventDefault();
    if (level === 'sub' && drillOut()) return;
    if (level === 'sub' || subOf >= 0) closeSub(); else closeCtxMenu();
  } else if (k === 'ArrowDown' || k === 'ArrowUp') { e.preventDefault(); move(k === 'ArrowDown' ? 1 : -1); }
  else if (k === 'Home' || k === 'End') { e.preventDefault(); ends(k); }
  else if (k === 'ArrowRight') {
    e.preventDefault();
    if (level === 'main' && hasKids(items[sel])) openSub(sel, true);
    else if (level === 'sub' && drillable(subItems[subSel])) drillIn(subSel);
  } else if (k === 'ArrowLeft') {
    e.preventDefault();
    if (level === 'sub' && drillOut()) return;
    if (level === 'sub' || subOf >= 0) closeSub();
  } else if (k === 'Enter' || k === ' ') {
    e.preventDefault();
    if (level === 'sub') pickSub(subSel); else pick(sel);
  } else if (k === 'Tab') { e.preventDefault(); move(e.shiftKey ? -1 : 1); }
  else if (!e.ctrlKey && !e.altKey && !e.metaKey) e.preventDefault();
}, true);
// a press or a wheel anywhere else closes it (the press still does what it does there)
const inside = (t) => t instanceof Node && (el.contains(t) || (subEl && subEl.contains(t)));
document.addEventListener('pointerdown', (e) => { if (open && !inside(e.target)) closeCtxMenu(false); }, true);
document.addEventListener('wheel', (e) => { if (open && !inside(e.target)) closeCtxMenu(false); }, { capture: true, passive: true });
let keepUntil = 0; // until then a scroll outside the menu (the page redrawing after a stay item) leaves it open
document.addEventListener('scroll', (e) => { if (open && !inside(e.target) && Date.now() > keepUntil) closeCtxMenu(false); }, true);
// a resize that leaves the window its size (the page redrawing after a stay item fires these) leaves it open
let openSize = '';
const winSize = () => `${window.innerWidth}x${window.innerHeight}`;
window.addEventListener('resize', () => { if (open && (winSize() !== openSize && Date.now() > keepUntil)) closeCtxMenu(false); });
// (not while it is a text box: copying a path from another window takes the focus away and back)
window.addEventListener('blur', () => { if (!inputFor) closeCtxMenu(false); });
