// Find in the page (Ctrl+F): the desktop window has no find of its own, so this is one. A small bar at the top
// right; typing marks every match on screen, Enter (or F3) goes to the next, Shift+Enter (Shift+F3) to the one
// before, Esc closes it. In Edge (no window.fleetDesktop) Ctrl+F stays the browser's own find.
//
// The matches are CSS highlights (the Highlight API): nothing in the page changes, so the chat feed can redraw
// under it. Only text that is on screen counts (not a closed tool row, not another tab, not the terminal's
// canvas); the matches are found again on every key, so what the feed adds meanwhile is found too.

const MAX = 2000; // matches marked at most
const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT', 'SVG', 'svg']);

const hl = typeof CSS !== 'undefined' && CSS.highlights && typeof Highlight === 'function';
let bar = null, input = null, count = null, ranges = [], cur = -1, lastQ = '';

function css() {
  const s = document.createElement('style');
  s.textContent = `
.fv-find { position: fixed; top: calc(var(--top-h, 48px) + 8px); right: 18px; z-index: 900; display: flex; align-items: center; gap: 4px;
  padding: 5px 6px 5px 10px; border-radius: 10px; background: var(--glass-bg-strong, #151927); border: 1px solid var(--glass-edge, #333);
  box-shadow: 0 10px 30px rgba(0, 0, 0, .45); backdrop-filter: blur(18px); font: 13px var(--font-ui, system-ui); color: var(--text, #eee); }
.fv-find[hidden] { display: none; }
.fv-find input { width: 220px; background: transparent; border: 0; outline: 0; color: inherit; font: inherit; }
.fv-find .fv-find-n { min-width: 52px; text-align: right; color: var(--dim, #999); font: 12px var(--font-mono, monospace); }
.fv-find .fv-find-n.none { color: var(--red, #f55); }
.fv-find button { width: 26px; height: 26px; display: grid; place-items: center; border: 0; border-radius: 7px; background: transparent; color: var(--dim, #999); cursor: pointer; }
.fv-find button:hover { background: var(--hover, rgba(255,255,255,.06)); color: var(--text, #eee); }
.fv-find button:disabled { opacity: .35; cursor: default; background: transparent; }
::highlight(fv-find) { background-color: rgba(255, 194, 74, .32); color: inherit; }
::highlight(fv-find-cur) { background-color: #ff9a3d; color: #10131c; }`;
  document.head.appendChild(s);
}

const svg = (d) => `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`;
function build() {
  css();
  bar = document.createElement('div');
  bar.className = 'fv-find';
  bar.hidden = true;
  bar.setAttribute('role', 'search');
  bar.innerHTML = `<input type="text" spellcheck="false" autocomplete="off" placeholder="Find in page" aria-label="find in page">`
    + `<span class="fv-find-n" aria-live="polite"></span>`
    + `<button type="button" data-f="prev" title="Previous (Shift+Enter)" aria-label="previous match">${svg('M18 15l-6-6-6 6')}</button>`
    + `<button type="button" data-f="next" title="Next (Enter)" aria-label="next match">${svg('M6 9l6 6 6-6')}</button>`
    + `<button type="button" data-f="close" title="Close (Esc)" aria-label="close find">${svg('M18 6L6 18M6 6l12 12')}</button>`;
  document.body.appendChild(bar);
  input = bar.querySelector('input');
  count = bar.querySelector('.fv-find-n');
  input.addEventListener('input', () => search(true));
  input.addEventListener('keydown', (e) => {
    e.stopPropagation(); // the page's single-key shortcuts stay out of it
    if (e.key === 'Enter' || e.key === 'F3') { e.preventDefault(); step(e.shiftKey ? -1 : 1); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
  });
  bar.addEventListener('pointerdown', (e) => { if (e.target.closest('button')) e.preventDefault(); }); // keep the focus in the box
  bar.addEventListener('click', (e) => {
    const f = e.target.closest('button')?.dataset.f;
    if (f === 'close') close();
    else if (f) step(f === 'prev' ? -1 : 1);
  });
}

// every match of q in the text on screen, in page order
function collect(q) {
  const out = [];
  const needle = q.toLowerCase();
  const seen = new Map(); // element -> shown or not (one check per element, not per text node)
  const shown = (el) => {
    if (seen.has(el)) return seen.get(el);
    const v = el.getClientRects().length > 0 && !el.closest('.fv-find, .xterm, [aria-hidden="true"]');
    seen.set(el, v);
    return v;
  };
  const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => {
      const p = n.parentElement;
      if (!p || SKIP.has(p.tagName) || !n.data || !shown(p)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  for (let n = walk.nextNode(); n && out.length < MAX; n = walk.nextNode()) {
    const hay = n.data.toLowerCase();
    for (let i = hay.indexOf(needle); i >= 0 && out.length < MAX; i = hay.indexOf(needle, i + needle.length)) {
      const r = new Range();
      r.setStart(n, i);
      r.setEnd(n, i + needle.length);
      out.push(r);
    }
  }
  return out;
}

// scroll every scrolling box around the match so it sits in view (the feed, then the page)
function reveal(r) {
  for (let el = r.startContainer.parentElement; el && el !== document.documentElement; el = el.parentElement) {
    const oy = getComputedStyle(el).overflowY;
    if (!/(auto|scroll)/.test(oy) || el.scrollHeight <= el.clientHeight) continue;
    const box = el.getBoundingClientRect(), at = r.getBoundingClientRect();
    if (at.top < box.top + 8 || at.bottom > box.bottom - 8) el.scrollTop += at.top - box.top - el.clientHeight / 3;
  }
}

function paint() {
  if (!hl) return;
  CSS.highlights.set('fv-find', new Highlight(...ranges.filter((_, i) => i !== cur)));
  if (cur >= 0 && ranges[cur]) CSS.highlights.set('fv-find-cur', new Highlight(ranges[cur]));
  else CSS.highlights.delete('fv-find-cur');
}
function drawCount() {
  const q = input.value;
  count.textContent = !q ? '' : ranges.length ? `${cur + 1}/${ranges.length}${ranges.length >= MAX ? '+' : ''}` : '0/0';
  count.classList.toggle('none', !!q && !ranges.length);
  for (const b of bar.querySelectorAll('[data-f="prev"], [data-f="next"]')) b.disabled = !ranges.length;
}

// find again; fresh (the text changed): the first match at or below where the view is, else keep the place
function search(fresh) {
  const q = input.value;
  const was = ranges[cur];
  const wasTop = was ? was.getBoundingClientRect().top : null;
  ranges = q ? collect(q) : [];
  if (!ranges.length) cur = -1;
  else if (fresh || q !== lastQ || wasTop == null) {
    const top = (document.querySelector('.chat-feed') || document.body).getBoundingClientRect().top;
    cur = Math.max(0, ranges.findIndex((r) => r.getBoundingClientRect().top >= top));
  } else {
    // the same match as before if it is still there (the feed may have redrawn it), else the nearest after it
    cur = ranges.findIndex((r) => r.getBoundingClientRect().top >= wasTop - 1);
    if (cur < 0) cur = ranges.length - 1;
  }
  lastQ = q;
  paint();
  drawCount();
  if (fresh && cur >= 0) reveal(ranges[cur]);
}
function step(by) {
  if (!input.value) return;
  search(false);
  if (!ranges.length) return;
  cur = (cur + by + ranges.length) % ranges.length;
  paint();
  drawCount();
  reveal(ranges[cur]);
}

function open() {
  if (!bar) build();
  bar.hidden = false;
  input.focus();
  input.select();
  if (input.value) search(false);
}
function close() {
  if (!bar) return;
  bar.hidden = true;
  ranges = []; cur = -1;
  if (hl) { CSS.highlights.delete('fv-find'); CSS.highlights.delete('fv-find-cur'); }
}

// Ctrl+F before anything else sees it (the chat box keeps its keys to itself); not in the terminal, where
// Claude Code has the keys
if (window.fleetDesktop && window.fleetDesktop.isDesktop) {
  window.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    const findKey = (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && k === 'f';
    if (findKey && !document.activeElement?.closest?.('.xterm')) { e.preventDefault(); e.stopPropagation(); open(); return; }
    if (e.key === 'F3' && bar && !bar.hidden) { e.preventDefault(); e.stopPropagation(); step(e.shiftKey ? -1 : 1); }
  }, true);
}
