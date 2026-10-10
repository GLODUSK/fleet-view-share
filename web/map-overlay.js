// Fleet View web: the Map's overlay (the controls that sit on top of the canvas).
//
// map.js mounts this once it has its container: mountMapOverlay(el, api) adds one layer of DOM over the canvas
// and returns { frame(now), key(e), destroy() }. The map calls frame after each frame it draws, passes the keys
// it doesn't handle to key (true when handled), and calls destroy when it lets go of the container. The overlay
// knows the map only through api:
//   nodes()   -> [{ id, kind, x, y (world), sx, sy (screen), r, color, state, needsYou, name, sid }]
//   camera()  -> { pan, zoom, W, H, k, toScreen(x, y), toWorld(sx, sy), bounds: { minX, minY, maxX, maxY } }
//   panTo(worldX, worldY, zoom?), select(nodeId), lens(), setLens(name), state() -> the /state last drawn
//
// What it shows, all in the frosted look of the map's tooltip and legend (GLASS_BOX, copied from map.js):
//   Edge pointers: every conversation that needs you (asking, a question, stalled, an error) and sits off screen
//     gets a small pill at the edge of the view, its chevron turned toward it, with its name and how long it has
//     waited ("asking · 12m"), in its state colour. A click glides the view to it and picks it. Pointers that
//     would overlap on one edge are stacked into one, the longest waiting in front, with "+2" for the rest
//     (clicking brings that one into view, so the next click goes to the next).
//   Minimap: bottom right, 180 x 120, while zoomed in past 1.3 or when the map is bigger than the view: a dot
//     per repo hub (its colour) and per conversation (small), and the view as a rectangle. Click or drag on it
//     to move the view there (the mapping holds still while dragging, so the rectangle follows the pointer).
//   Lens chips: top left, a small segmented control (State, Cost, Account, Idle, Context) that calls
//     api.setLens and shows the lens in use (the map's `k` key cycles it too).
//   Replay: a clock button bottom left (or `t`) opens a scrubber bar along the bottom: a range of the last 1h,
//     6h or 24h, play/pause at 1x, 10x or 60x, a slider with the range's ship events marked on it (merged violet,
//     live mint, failed red), the moment's time and a summary ("3 live · 2 waiting · $4.10 so far"), and Live
//     to go back. It uses replay.js, which dispatches window 'fv-replay' { on: true, state } for each moment and
//     { on: false } when it ends; the shell then draws that state instead of the live one. While the bar is
//     open, Space plays or pauses, the arrows step a sixtieth of the range (Shift: a twelfth), Esc or `t`
//     closes it and returns to live.
//
// House rules, as on the map: nothing pulses, blinks, flashes or gets brighter when something happens; every
// colour and alpha here is fixed (hover is the only highlight, and it is the user's own doing). Nothing is
// animated, so prefers-reduced-motion has nothing to turn off; the view's glides are the map's (panTo).
// The DOM is only written when something changed: pointers by their text and place, the minimap when the view
// or the nodes moved (or every 250 ms), the chips when the lens changed.

import { icon } from './icons.js';
import { createReplay, replaySummary } from './replay.js';

const COL = {
  text: '#eef0fa', dim: '#8a92b2', faint: '#4c5372', gold: '#ffc24a', violet: '#a47bff', cyan: '#3fd8ff', mint: '#3dffa8', red: '#ff4d5e',
};
const UI = "'Segoe UI Variable Text', 'Segoe UI', system-ui, sans-serif";
const MONO = "'Cascadia Mono', Consolas, monospace";
const CSS_UI = `var(--font-ui, ${UI})`, CSS_MONO = `var(--font-mono, ${MONO})`;
const GLASS_BOX = 'background:var(--float-bg, var(--glass-bg-strong, rgba(18,21,32,0.78)));border:1px solid var(--glass-edge, rgba(255,255,255,0.07));' +
  'box-shadow:inset 0 1px 0 var(--glass-highlight, rgba(255,255,255,0.10)),0 10px 30px rgba(0,0,0,0.35);' +
  'backdrop-filter:blur(18px) saturate(1.3);-webkit-backdrop-filter:blur(18px) saturate(1.3);' +
  'color:var(--text, #eef0fa);font-variant-numeric:tabular-nums;';

const NEEDS_YOU = new Set(['ASKING', 'QUESTION', 'STALLED', 'ERROR']);
const LENSES = [['state', 'State'], ['cost', 'Cost'], ['account', 'Account'], ['idle', 'Idle'], ['context', 'Context']];
const RANGES = [[3600e3, '1h'], [6 * 3600e3, '6h'], [24 * 3600e3, '24h']];
const SPEEDS = [1, 10, 60];
const SHIP_COL = { merged: COL.violet, live: COL.mint, deployFail: COL.red, checksFail: COL.red };
const MINI_W = 180, MINI_H = 120, MINI_ZOOM = 1.3, MINI_EVERY = 250;
const PAD = 14, TOP = 50, LOW = 56;    // the pointers' edges: clear of the sides, the lens chips and the clock button
const STACK_V = 30, STACK_H = 160;     // pointers closer than this along one edge stack into one
const SVG_CHEV = '<svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 1.5 10 6l-7 4.5 1.8-4.5Z" fill="currentColor"/></svg>';
const SVG_PLAY = '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 4.5v15l12.5-7.5Z"/></svg>';
const SVG_PAUSE = '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="4.5" width="4" height="15" rx="1"/><rect x="14" y="4.5" width="4" height="15" rx="1"/></svg>';

const STYLE = `
.fvo-btn{all:unset;box-sizing:border-box;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:5px;
  font:600 11px/1 ${CSS_UI};color:${COL.dim};padding:5px 8px;border-radius:7px;white-space:nowrap}
.fvo-btn:hover{background:rgba(255,255,255,0.06);color:${COL.text}}
.fvo-btn.on{background:rgba(255,255,255,0.11);color:${COL.text}}
.fvo-seg{display:inline-flex;gap:1px;padding:2px;border-radius:9px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.05)}
.fvo-ptr{position:absolute;left:0;top:0;pointer-events:auto;cursor:pointer;display:flex;align-items:center;gap:6px;
  max-width:240px;padding:5px 10px 5px 7px;border-radius:999px;font:12px/1.2 ${CSS_UI};white-space:nowrap;user-select:none}
.fvo-ptr:hover{border-color:rgba(255,255,255,0.18)}
.fvo-ptr .nm{overflow:hidden;text-overflow:ellipsis;font-weight:600}
.fvo-ptr .wt{color:${COL.dim}}
.fvo-ptr .more{font:600 10.5px/1 ${CSS_MONO};color:${COL.dim};padding:2px 5px;border-radius:999px;background:rgba(255,255,255,0.07)}
.fvo-range{width:100%;margin:0;accent-color:${COL.cyan};cursor:pointer;background:transparent}
.fvo-range:focus-visible{outline:1px solid rgba(255,255,255,0.22);outline-offset:3px;border-radius:4px}
`;

const div = (css, cls) => { const d = document.createElement('div'); if (css) d.style.cssText = css; if (cls) d.className = cls; return d; };
function button(html, title, onClick, cls = 'fvo-btn') {
  const b = document.createElement('button');
  b.type = 'button'; b.className = cls; b.innerHTML = html; if (title) b.title = title;
  b.tabIndex = -1;
  b.addEventListener('mousedown', (e) => e.preventDefault()); // keep the keyboard on the page
  b.addEventListener('click', (e) => { e.stopPropagation(); onClick(e); });
  return b;
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function waitText(ms) {
  const m = Math.floor(Math.max(0, ms) / 60e3);
  if (m < 1) return 'now';
  if (m < 60) return m + 'm';
  return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
}
function agoText(ms) {
  const s = Math.round(Math.max(0, ms) / 1000);
  if (s < 45) return 'now';
  if (s < 3600) return Math.round(s / 60) + 'm ago';
  return Math.floor(s / 3600) + 'h ' + (Math.floor(s / 60) % 60) + 'm ago';
}
function clockText(t, withDay) {
  const d = new Date(t);
  const hm = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return withDay ? d.toLocaleDateString([], { weekday: 'short' }) + ' ' + hm : hm;
}

export function mountMapOverlay(el, api) {
  const O = {
    dead: false, live: null, lens: undefined, barOpen: false, info: null,
    ptrs: new Map(),                 // lead node id -> { el, sig, pos }
    sessById: new Map(), sessFor: null,
    mini: { shown: false, sig: '', at: 0, map: null, drag: false, dpr: 0 },
  };
  const call = (name, ...a) => { try { return typeof api[name] === 'function' ? api[name](...a) : undefined; } catch (e) { console.error(e); return undefined; } };

  const root = div(`position:absolute;inset:0;pointer-events:none;z-index:3;font:12px/1.4 ${CSS_UI};color:${COL.text}`, 'fv-map-overlay');
  const style = document.createElement('style');
  style.textContent = STYLE;
  root.appendChild(style);
  el.appendChild(root);
  const ptrLayer = div('position:absolute;inset:0;pointer-events:none;overflow:hidden');
  root.appendChild(ptrLayer);

  // ---------- lens chips ----------
  let lensBar = null;
  const lensBtns = new Map();
  if (typeof api.setLens === 'function') {
    lensBar = div(`position:absolute;left:${PAD}px;top:12px;pointer-events:auto;${GLASS_BOX};border-radius:10px;padding:2px;display:flex;gap:1px`);
    lensBar.title = 'Map lens (k cycles)';
    for (const [name, label] of LENSES) {
      const b = button(esc(label), null, () => { call('setLens', name); O.lens = undefined; });
      lensBtns.set(name, b);
      lensBar.appendChild(b);
    }
    root.appendChild(lensBar);
  }
  function updateLens() {
    if (!lensBar) return;
    const cur = call('lens') || 'state';
    if (cur === O.lens) return;
    O.lens = cur;
    for (const [name, b] of lensBtns) b.classList.toggle('on', name === cur);
  }

  // ---------- edge pointers ----------
  function sessionsOf(st) {
    if (O.sessFor !== st) { O.sessFor = st; O.sessById = new Map(((st && st.sessions) || []).map((s) => [s.id, s])); }
    return O.sessById;
  }
  function pickNode(id) {
    const n = (call('nodes') || []).find((m) => m.id === id);
    if (!n) return;
    call('panTo', n.x, n.y);
    call('select', n.id);
  }
  function updatePointers(cam, nodes, st) {
    const W = cam.W, H = cam.H;
    const bottom = H - (O.barOpen ? barEl.offsetHeight + PAD + 10 : LOW);
    const box = { l: PAD, t: TOP, r: W - PAD, b: Math.max(TOP + 30, bottom) };
    // keep clear of the minimap: right-edge pointers stay above it, bottom-edge ones left of it
    const miniTop = O.mini.shown ? H - (O.mini.bottom || 40) - MINI_H - 8 : Infinity;
    const miniLeft = O.mini.shown ? W - PAD - MINI_W - 8 : Infinity;
    const cx = W / 2, cy = H / 2;
    const clock = st && st.replay && typeof st.now === 'number' ? st.now : Date.now();
    const byId = sessionsOf(st);
    const sides = { l: [], r: [], t: [], b: [] };
    for (const n of nodes) {
      if (!n || !n.needsYou || typeof n.sx !== 'number' || typeof n.sy !== 'number') continue;
      if (n.sx >= 0 && n.sx <= W && n.sy >= 0 && n.sy <= H) continue;
      const dx = n.sx - cx, dy = n.sy - cy;
      let s = Infinity, side = 'r';
      if (dx > 0 && (box.r - cx) / dx < s) { s = (box.r - cx) / dx; side = 'r'; }
      if (dx < 0 && (box.l - cx) / dx < s) { s = (box.l - cx) / dx; side = 'l'; }
      if (dy > 0 && (box.b - cy) / dy < s) { s = (box.b - cy) / dy; side = 'b'; }
      if (dy < 0 && (box.t - cy) / dy < s) { s = (box.t - cy) / dy; side = 't'; }
      if (!isFinite(s)) continue;
      const ss = byId.get(n.sid) || null;
      const since = ss ? ss.last || ss.turnStart || null : null;
      sides[side].push({
        n, side, px: cx + dx * s, py: cy + dy * s, ang: Math.atan2(dy, dx),
        since: since || clock, waited: clock - (since || clock), word: String((ss && ss.state) || n.state || 'waiting').toLowerCase(),
        color: (ss && ss.stateColor) || n.color || COL.gold, name: n.name || (ss && ss.name) || n.sid || n.id,
      });
    }
    const seen = new Set();
    for (const side of Object.keys(sides)) {
      const list = sides[side];
      if (!list.length) continue;
      const vert = side === 'l' || side === 'r';
      list.sort((a, b) => (vert ? a.py - b.py : a.px - b.px));
      // stack neighbours: one group per run of close pointers, the longest waiting in front
      const groups = [];
      for (const it of list) {
        const g = groups[groups.length - 1];
        const at = vert ? it.py : it.px;
        if (g && at - g.end < (vert ? STACK_V : STACK_H)) { g.items.push(it); g.end = at; } else groups.push({ items: [it], end: at });
      }
      for (const g of groups) {
        const lead = g.items.reduce((a, b) => (b.since < a.since ? b : a));
        const mid = g.items.reduce((s, it) => s + (vert ? it.py : it.px), 0) / g.items.length;
        placePointer(lead, g.items.length - 1, vert ? lead.px : mid, vert ? mid : lead.py, box, miniTop, miniLeft);
        seen.add(lead.n.id);
      }
    }
    for (const [id, p] of O.ptrs) if (!seen.has(id)) { p.el.remove(); O.ptrs.delete(id); }
  }
  function placePointer(it, more, px, py, box, miniTop, miniLeft) {
    const id = it.n.id;
    let p = O.ptrs.get(id);
    if (!p) {
      const e = div(GLASS_BOX, 'fvo-ptr');
      e.addEventListener('mousedown', (ev) => ev.preventDefault());
      e.addEventListener('click', (ev) => { ev.stopPropagation(); pickNode(id); });
      p = { el: e, sig: '', pos: '', w: 0, h: 0, rot: null, chev: null };
      ptrLayer.appendChild(e);
      O.ptrs.set(id, p);
    }
    const wait = `${it.word} · ${waitText(it.waited)}`;
    const sig = [it.name, wait, more, it.color].join('\u0001');
    if (sig !== p.sig) {
      p.sig = sig;
      p.el.innerHTML = `<span class="ch" style="display:inline-flex;color:${esc(it.color)}">${SVG_CHEV}</span>` +
        `<span class="nm" style="color:${esc(it.color)}">${esc(it.name)}</span><span class="wt">${esc(wait)}</span>` +
        (more > 0 ? `<span class="more">+${more}</span>` : '');
      p.el.title = more > 0 ? `${it.name} and ${more} more waiting off screen: click to go there` : `${it.name} is waiting off screen: click to go there`;
      p.chev = p.el.firstChild;
      p.rot = null;
      p.w = p.el.offsetWidth; p.h = p.el.offsetHeight;
    }
    const w = p.w, h = p.h;
    let x, y;
    if (it.side === 'r') { x = box.r - w; y = py - h / 2; }
    else if (it.side === 'l') { x = box.l; y = py - h / 2; }
    else if (it.side === 't') { x = px - w / 2; y = box.t - h / 2; }
    else { x = px - w / 2; y = box.b - h; }
    const maxX = it.side === 'b' ? Math.min(box.r, miniLeft) : box.r, maxY = it.side === 'r' ? Math.min(box.b, miniTop) : box.b;
    x = Math.round(Math.max(box.l, Math.min(maxX - w, x)));
    y = Math.round(Math.max(box.t - h / 2, Math.min(maxY - h, y)));
    const pos = `translate(${x}px,${y}px)`;
    if (pos !== p.pos) { p.pos = pos; p.el.style.transform = pos; }
    const rot = Math.round((it.ang * 180) / Math.PI);
    if (rot !== p.rot) { p.rot = rot; p.chev.style.transform = `rotate(${rot}deg)`; }
  }

  // ---------- minimap ----------
  const miniWrap = div(`position:absolute;right:${PAD}px;bottom:40px;width:${MINI_W}px;height:${MINI_H}px;display:none;pointer-events:auto;` +
    `${GLASS_BOX};border-radius:10px;overflow:hidden;cursor:crosshair`);
  miniWrap.title = 'Minimap: click or drag to move the view';
  const miniCv = document.createElement('canvas');
  miniCv.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block';
  miniWrap.appendChild(miniCv);
  root.appendChild(miniWrap);
  const mctx = miniCv.getContext('2d');

  function miniMapping(cam) {
    const b = cam.bounds || {};
    const [vx0, vy0] = cam.toWorld(0, 0), [vx1, vy1] = cam.toWorld(cam.W, cam.H);
    let x0 = Math.min(vx0, vx1), y0 = Math.min(vy0, vy1), x1 = Math.max(vx0, vx1), y1 = Math.max(vy0, vy1);
    if (isFinite(b.minX) && isFinite(b.maxX) && isFinite(b.minY) && isFinite(b.maxY)) {
      x0 = Math.min(x0, b.minX); y0 = Math.min(y0, b.minY); x1 = Math.max(x1, b.maxX); y1 = Math.max(y1, b.maxY);
    }
    const bw = Math.max(1, x1 - x0), bh = Math.max(1, y1 - y0);
    const s = Math.min((MINI_W - 16) / bw, (MINI_H - 16) / bh);
    const ox = (MINI_W - bw * s) / 2 - x0 * s, oy = (MINI_H - bh * s) / 2 - y0 * s;
    return { s, ox, oy };
  }
  function miniWanted(cam) {
    if (cam.zoom > MINI_ZOOM) return true;
    const b = cam.bounds;
    if (!b || !isFinite(b.minX) || !isFinite(b.maxX)) return false;
    const [ax, ay] = cam.toScreen(b.minX, b.minY), [bx, by] = cam.toScreen(b.maxX, b.maxY);
    return Math.min(ax, bx) < -4 || Math.min(ay, by) < -4 || Math.max(ax, bx) > cam.W + 4 || Math.max(ay, by) > cam.H + 4;
  }
  function updateMini(cam, nodes, now) {
    const want = O.mini.drag || miniWanted(cam);
    if (want !== O.mini.shown) { O.mini.shown = want; miniWrap.style.display = want ? 'block' : 'none'; O.mini.sig = ''; }
    const bottom = O.barOpen ? barEl.offsetHeight + PAD + 10 : 40;
    if (O.mini.bottom !== bottom) { O.mini.bottom = bottom; miniWrap.style.bottom = bottom + 'px'; }
    if (!want) return;
    const pan = cam.pan || { x: 0, y: 0 };
    const sig = [Math.round(pan.x), Math.round(pan.y), Math.round(cam.zoom * 1000), cam.W, cam.H, nodes.length].join(',');
    if (sig === O.mini.sig && now - O.mini.at < MINI_EVERY) return;
    O.mini.sig = sig; O.mini.at = now;
    const dpr = window.devicePixelRatio || 1;
    if (dpr !== O.mini.dpr) { O.mini.dpr = dpr; miniCv.width = Math.round(MINI_W * dpr); miniCv.height = Math.round(MINI_H * dpr); }
    const m = O.mini.map || miniMapping(cam);
    const c = mctx;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, MINI_W, MINI_H);
    for (const n of nodes) {
      if (!n || typeof n.x !== 'number' || (n.kind !== 'repo' && n.kind !== 'session')) continue;
      const x = m.ox + n.x * m.s, y = m.oy + n.y * m.s;
      c.globalAlpha = n.kind === 'repo' ? 0.95 : 0.8;
      c.fillStyle = n.color || COL.dim;
      c.beginPath(); c.arc(x, y, n.kind === 'repo' ? 3.2 : 1.7, 0, Math.PI * 2); c.fill();
      if (n.needsYou) { c.globalAlpha = 0.9; c.strokeStyle = COL.gold; c.lineWidth = 1; c.beginPath(); c.arc(x, y, 3.4, 0, Math.PI * 2); c.stroke(); }
    }
    c.globalAlpha = 1;
    const [vx0, vy0] = cam.toWorld(0, 0), [vx1, vy1] = cam.toWorld(cam.W, cam.H);
    const rx = m.ox + vx0 * m.s, ry = m.oy + vy0 * m.s, rw = (vx1 - vx0) * m.s, rh = (vy1 - vy0) * m.s;
    c.fillStyle = 'rgba(255,255,255,0.05)';
    c.fillRect(rx, ry, rw, rh);
    c.strokeStyle = 'rgba(238,240,250,0.6)'; c.lineWidth = 1;
    c.strokeRect(Math.round(rx) + 0.5, Math.round(ry) + 0.5, Math.max(2, Math.round(rw) - 1), Math.max(2, Math.round(rh) - 1));
  }
  function miniPan(e) {
    const m = O.mini.map;
    if (!m) return;
    const r = miniWrap.getBoundingClientRect();
    const wx = (e.clientX - r.left - m.ox) / m.s, wy = (e.clientY - r.top - m.oy) / m.s;
    call('panTo', wx, wy);
    O.mini.sig = '';
  }
  miniWrap.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    const cam = call('camera');
    if (!cam) return;
    O.mini.map = miniMapping(cam); // hold the mapping still while dragging
    O.mini.drag = true;
    try { miniWrap.setPointerCapture(e.pointerId); } catch { /* old browser */ }
    miniPan(e);
  });
  miniWrap.addEventListener('pointermove', (e) => { if (O.mini.drag) { e.stopPropagation(); miniPan(e); } });
  const miniUp = (e) => {
    if (!O.mini.drag) return;
    O.mini.drag = false; O.mini.map = null; O.mini.sig = '';
    try { miniWrap.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
  };
  miniWrap.addEventListener('pointerup', miniUp);
  miniWrap.addEventListener('pointercancel', miniUp);
  for (const ev of ['click', 'dblclick', 'contextmenu', 'wheel']) miniWrap.addEventListener(ev, (e) => { e.stopPropagation(); if (ev !== 'wheel') e.preventDefault(); });

  // ---------- replay ----------
  const replay = createReplay({ live: () => O.live, onChange: (info) => { O.info = info; drawBar(); } });
  const clockBtn = button(icon('clock', 15), 'Replay: see the map as it was (t)', () => openBar());
  clockBtn.style.cssText = `position:absolute;left:${PAD}px;bottom:${PAD}px;width:32px;height:32px;padding:0;border-radius:999px;pointer-events:auto;${GLASS_BOX};color:${COL.dim}`;
  root.appendChild(clockBtn);

  const barEl = div(`position:absolute;left:${PAD}px;right:${PAD}px;bottom:${PAD}px;display:none;pointer-events:auto;${GLASS_BOX};` +
    'border-radius:12px;padding:6px 8px;align-items:center;gap:8px;flex-wrap:wrap');
  const head = div(`display:inline-flex;align-items:center;gap:6px;color:${COL.dim};font:600 11px/1 ${CSS_UI};letter-spacing:0.04em;padding:0 2px 0 4px`);
  head.innerHTML = `${icon('clock', 14)}<span>REPLAY</span>`;
  const rangeSeg = div('', 'fvo-seg');
  const rangeBtns = RANGES.map(([ms, label]) => {
    const b = button(label, `The last ${label}`, () => { if (O.info && O.info.range !== ms) replay.load(ms); });
    b.dataset.ms = ms; rangeSeg.appendChild(b); return b;
  });
  const playBtn = button(SVG_PLAY, 'Play or pause (Space)', () => replay.toggle());
  playBtn.style.cssText = 'width:30px;height:26px;padding:0;color:#eef0fa;background:rgba(255,255,255,0.07)';
  const speedSeg = div('', 'fvo-seg');
  const speedBtns = SPEEDS.map((x) => {
    const b = button(x + 'x', `Play at ${x} times real time`, () => replay.setSpeed(x));
    b.dataset.x = x; speedSeg.appendChild(b); return b;
  });
  const track = div('position:relative;flex:1 1 220px;min-width:140px;height:26px;display:flex;align-items:center');
  const ticks = div('position:absolute;left:8px;right:8px;top:0;height:6px;pointer-events:none');
  const slider = document.createElement('input');
  slider.type = 'range'; slider.className = 'fvo-range'; slider.min = '0'; slider.max = '1'; slider.step = '1000'; slider.value = '1';
  slider.title = 'Drag to move through time (arrows step, Shift steps more)';
  slider.addEventListener('input', () => replay.seek(+slider.value));
  track.append(ticks, slider);
  const readout = div(`display:flex;flex-direction:column;gap:2px;min-width:170px;padding:0 4px;white-space:nowrap`);
  const rTime = div(`font:600 12.5px/1.2 ${CSS_UI}`), rSum = div(`font:11px/1.2 ${CSS_UI};color:${COL.dim}`);
  readout.append(rTime, rSum);
  const liveBtn = button(`<span style="width:7px;height:7px;border-radius:50%;background:${COL.mint};display:inline-block"></span>Live`, 'Back to live (Esc)', () => closeBar());
  liveBtn.style.cssText = `color:${COL.text};background:rgba(255,255,255,0.07);padding:6px 10px;margin-left:auto`;
  const closeBtn = button(icon('close', 14) || '×', 'Close the replay (Esc)', () => closeBar());
  closeBtn.setAttribute('aria-label', 'close the replay');
  closeBtn.style.cssText = 'width:26px;height:26px;padding:0';
  barEl.append(head, rangeSeg, playBtn, speedSeg, track, readout, liveBtn, closeBtn);
  root.appendChild(barEl);
  // keys while the slider has the focus (the map ignores keys typed into inputs)
  barEl.addEventListener('keydown', (e) => { if (barKey(e)) { e.preventDefault(); e.stopPropagation(); } });

  let ticksFor = null;
  function drawBar() {
    const info = O.info;
    if (!O.barOpen || !info) return;
    for (const b of rangeBtns) b.classList.toggle('on', +b.dataset.ms === info.range);
    for (const b of speedBtns) b.classList.toggle('on', +b.dataset.x === info.speed);
    playBtn.innerHTML = info.playing ? SVG_PAUSE : SVG_PLAY;
    const tl = replay.timeline();
    if (info.loading && !tl) { rTime.textContent = 'Loading the timeline…'; rSum.textContent = ''; return; }
    if (info.error) { rTime.textContent = 'No replay'; rSum.textContent = info.error; rSum.style.color = COL.red; return; }
    rSum.style.color = COL.dim;
    if (!tl) return;
    slider.min = String(Math.round(info.from)); slider.max = String(Math.round(info.to));
    if (document.activeElement !== slider || info.playing) slider.value = String(Math.round(info.t));
    rTime.textContent = `${clockText(info.t, info.range > 12 * 3600e3)} · ${agoText(Date.now() - info.t)}${info.loading ? ' · loading…' : ''}`;
    rSum.textContent = replaySummary(tl, info.t);
    if (ticksFor !== tl) {
      ticksFor = tl;
      ticks.textContent = '';
      const span = Math.max(1, info.to - info.from);
      for (const s of (tl.ships || []).slice(-200)) {
        const u = (s.t - info.from) / span;
        if (!(u >= 0 && u <= 1)) continue;
        const k = div(`position:absolute;top:0;width:2px;height:6px;border-radius:1px;left:calc(${(u * 100).toFixed(3)}% - 1px);background:${SHIP_COL[s.kind] || COL.dim}`);
        ticks.appendChild(k);
      }
    }
  }
  function openBar() {
    if (O.barOpen || O.dead) return;
    const st = call('state');
    if (st && !st.replay) O.live = st;
    O.barOpen = true;
    barEl.style.display = 'flex';
    clockBtn.style.display = 'none';
    ticksFor = null;
    replay.start((O.info && O.info.range) || RANGES[0][0]);
  }
  function closeBar() {
    if (!O.barOpen) return;
    O.barOpen = false;
    barEl.style.display = 'none';
    clockBtn.style.display = '';
    if (barEl.contains(document.activeElement)) document.activeElement.blur();
    replay.exit(); // dispatches fv-replay { on: false }
  }
  function barKey(e) {
    if (e.ctrlKey || e.altKey || e.metaKey) return false;
    const k = e.key;
    if (k === 't' || k === 'T' || k === 'Escape') { closeBar(); return true; }
    if (k === ' ' || k === 'Spacebar') { replay.toggle(); return true; }
    if (k === 'ArrowLeft' || k === 'ArrowRight') {
      const info = replay.info();
      if (!info.open || !replay.timeline()) return true;
      const stepMs = info.range / (e.shiftKey ? 12 : 60);
      replay.seek(info.t + (k === 'ArrowLeft' ? -stepMs : stepMs));
      return true;
    }
    return false;
  }

  // ---------- the map's hooks ----------
  function frame(now) {
    if (O.dead) return;
    const cam = call('camera');
    if (!cam || !cam.W || !cam.H || typeof cam.toWorld !== 'function') return;
    const nodes = call('nodes') || [];
    const st = call('state');
    if (st && !st.replay) O.live = st;
    updateLens();
    updatePointers(cam, nodes, st);
    updateMini(cam, nodes, typeof now === 'number' ? now : performance.now());
  }
  function key(e) {
    if (O.dead || !e || e.ctrlKey || e.altKey || e.metaKey) return false;
    const k = e.key;
    let handled = false;
    if (!O.barOpen) { if (k === 't' || k === 'T') { openBar(); handled = true; } }
    else if (k === 't' || k === 'T' || k === 'Escape' || k === ' ' || k === 'Spacebar') handled = barKey(e);
    if (handled) e.preventDefault();
    return handled;
  }
  // the header's Replay pill (app.js) goes back to live: close the bar too
  const onReplayExit = () => { if (!O.dead) closeBar(); };
  window.addEventListener('fv-replay-exit', onReplayExit);
  function destroy() {
    if (O.dead) return;
    window.removeEventListener('fv-replay-exit', onReplayExit);
    if (O.barOpen) closeBar();
    replay.destroy();
    O.dead = true;
    root.remove();
    O.ptrs.clear();
  }
  // for tests (?fixture=1 or ?debug=1): the overlay's own numbers
  try {
    if (/[?&](fixture|debug)=1/.test(location.search)) {
      window.__mapOverlay = {
        pointers: () => [...O.ptrs.entries()].map(([id, p]) => ({ id, text: p.el.textContent, transform: p.pos, rect: p.el.getBoundingClientRect().toJSON() })),
        mini: () => ({ shown: O.mini.shown }), bar: () => ({ open: O.barOpen, ...(O.info || {}) }), replay, open: openBar, close: closeBar,
      };
    }
  } catch { /* no location */ }
  return { frame, key, destroy };
}
