// Styled pickers for forms (the Bots tab's New bot and Edit bot), in place of a browser <select>: a button showing
// the current choice that opens a menu in the chat box's model-menu look (compose.css .cmp-menu / .cmp-mi / .cmp-mh,
// reused so both stay one style; picker bits in chats.css .pk-*).
//
// mountPicker(host, o) -> { value, set(v), redraw(), close() }
//   o.options: [{ value, label, btn?, art?, html?, note?, head?, sep?, wide?, custom? }] or a function returning
//     them, read on every draw (so a pick elsewhere can change how they look, and another choice is one more entry):
//     btn: the button's inner HTML when it is the pick (else its label); art: HTML before the label in the menu (in
//     a grid, the whole tile); html: the label as HTML; note: a grey line under it; head: a heading row; sep: a rule
//     above it; wide: a grid tile two columns wide; custom: a "pick any colour" tile (the browser's colour dialog)
//   o.value, o.onChange(v), o.labelId (the field's label element's id), o.grid (columns: a grid of tiles), o.empty
//     (the button's text when no choice matches)
// Keyboard: ↓ ↑ Enter or Space on the button opens it on the current choice; ↑↓ (←→ and rows of the grid) move,
// Home/End, Enter or Space picks, Esc closes back on the button (and goes no further: the form stays), Tab closes.
// A click outside, or the focus moving elsewhere, closes it. The menu opens below the button, or above when the form's scroll box has no room below.
import { esc } from './cards.js';
import { icon } from './icons.js';

const COLOR6 = /^#[0-9a-f]{6}$/i;
let seq = 0; // ids for the button's value, so a screen reader reads the field's label and then the choice

export function mountPicker(host, o) {
  let value = o.value;
  let isOpen = false;
  const valId = `pk-v${++seq}`;
  host.classList.add('pk');
  host.innerHTML = `<button type="button" class="pk-b" aria-haspopup="menu" aria-expanded="false"${o.labelId ? ` aria-labelledby="${esc(o.labelId)} ${valId}"` : ''}></button>`
    + `<div class="cmp-menu pk-menu${o.grid ? ' pk-grid' : ''}" role="menu"${o.grid ? ` style="--cols:${o.grid}"` : ''} hidden></div>`;
  const btn = host.querySelector('.pk-b'), menu = host.querySelector('.pk-menu');
  let colorIn = null; // the custom colour's <input type="color">, made on first use
  const opts = () => (typeof o.options === 'function' ? o.options() : o.options) || [];
  const cur = () => opts().find((x) => !x.head && !x.custom && x.value === value) || null;
  const items = () => [...menu.querySelectorAll('.pk-mi')];

  function drawBtn() {
    const c = cur();
    btn.innerHTML = `<span class="pk-v" id="${valId}">${c ? c.btn || esc(c.label) : esc(o.empty || String(value ?? ''))}</span>${icon('chevron', 11)}`;
    btn.title = c ? c.label : '';
  }
  function drawMenu() {
    menu.innerHTML = opts().map((x, i) => {
      if (x.head) return `<div class="cmp-mh">${esc(x.label)}</div>`;
      const on = !x.custom && x.value === value;
      const cls = `cmp-mi pk-mi${on ? ' on' : ''}${x.wide ? ' pk-wide' : ''}`;
      const inner = o.grid ? x.art || esc(x.label)
        : `<span class="cmp-mi-c">${on ? icon('check', 13) : ''}</span>${x.art || ''}<span class="pk-l">${x.html || esc(x.label)}${x.note ? `<span class="pk-note">${esc(x.note)}</span>` : ''}</span>`;
      return `${x.sep ? '<div class="cmp-msep" role="separator"></div>' : ''}<button type="button" role="menuitemradio" class="${cls}" data-i="${i}" aria-checked="${on}" title="${esc(x.label)}" aria-label="${esc(x.label)}" tabindex="-1">${inner}</button>`;
    }).join('');
  }
  const outside = (e) => { if (!host.contains(e.target)) close(); };
  function open() {
    if (isOpen || btn.disabled) return;
    isOpen = true;
    drawMenu();
    menu.hidden = false;
    menu.classList.remove('up');
    btn.setAttribute('aria-expanded', 'true');
    // no room below in the form's scroll box (or the window) but room above: it opens upwards
    const box = (host.closest('.ch-form') || document.documentElement).getBoundingClientRect();
    const b = btn.getBoundingClientRect(), h = menu.offsetHeight;
    if (b.bottom + h + 8 > Math.min(box.bottom, innerHeight) && b.top - h - 8 > Math.max(box.top, 0)) menu.classList.add('up');
    (menu.querySelector('.pk-mi.on') || menu.querySelector('.pk-mi'))?.focus();
    document.addEventListener('pointerdown', outside, true);
  }
  function close(refocus) {
    if (!isOpen) return;
    isOpen = false;
    menu.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', outside, true);
    if (refocus) btn.focus();
  }
  function choose(v) {
    const changed = v !== value;
    value = v;
    drawBtn();
    if (isOpen) drawMenu();
    if (changed) o.onChange?.(v);
  }
  // any colour: the browser's colour dialog; each colour tried shows at once, the menu is already shut
  function customColor() {
    if (!colorIn) {
      colorIn = document.createElement('input');
      colorIn.type = 'color';
      colorIn.className = 'pk-color';
      colorIn.tabIndex = -1;
      colorIn.setAttribute('aria-hidden', 'true');
      host.appendChild(colorIn);
      colorIn.addEventListener('input', () => choose(colorIn.value.toLowerCase()));
    }
    colorIn.value = COLOR6.test(String(value || '')) ? value : '#58a6ff';
    try { colorIn.showPicker ? colorIn.showPicker() : colorIn.click(); } catch { colorIn.click(); }
  }

  btn.addEventListener('click', () => (isOpen ? close(true) : open()));
  // the focus moved to something else (another picker, a text box): it closes
  host.addEventListener('focusout', (e) => { if (isOpen && e.relatedTarget && !host.contains(e.relatedTarget)) close(false); });
  btn.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); open(); }
  });
  menu.addEventListener('click', (e) => {
    const it = e.target.closest('.pk-mi');
    if (!it) return;
    const x = opts()[+it.dataset.i];
    if (!x) return;
    close(true);
    if (x.custom) customColor();
    else choose(x.value);
  });
  menu.addEventListener('keydown', (e) => {
    e.stopPropagation(); // the form's Esc (close the form) and the page's one-key shortcuts stay out
    const list = items();
    const i = list.indexOf(document.activeElement);
    const cols = o.grid || 1;
    const go = (j) => { e.preventDefault(); list[(j + list.length) % list.length]?.focus(); };
    if (e.key === 'Escape') { e.preventDefault(); close(true); }
    else if (e.key === 'Tab') close(false);
    else if (e.key === 'ArrowDown') go(o.grid ? Math.min(list.length - 1, i + cols) : i + 1);
    else if (e.key === 'ArrowUp') go(o.grid ? Math.max(0, i - cols) : i - 1);
    else if (e.key === 'ArrowRight' && o.grid) go(i + 1);
    else if (e.key === 'ArrowLeft' && o.grid) go(i - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(list.length - 1);
  });
  drawBtn();
  return {
    get value() { return value; },
    set(v) { value = v; drawBtn(); if (isOpen) drawMenu(); },
    redraw() { drawBtn(); if (isOpen) { const f = document.activeElement?.dataset?.i; drawMenu(); if (f != null) menu.querySelector(`[data-i="${f}"]`)?.focus(); } },
    close: () => close(false),
    disable(d) { btn.disabled = !!d; if (d) close(false); },
  };
}
