// Fleet View web: bots on the Map (Henry, 2026-10-13: "drag bots in when right-clicking the workspace, and when
// right-clicking on them I can set them to watch a conversation").
//
// map-overlay.js mounts this in its layer, under the edge pointers: mountMapBots(layer, api) -> { frame(now), destroy() }.
// api is the overlay's (map.js overlayApi): camera(), nodes(), state() (bots and sessions come from it) and ui() (the
// shell's: contextMenu, placeBot, watchBot, openBotChat; app.js).
// Every own bot with a spot (state.bots[].map: { x, y } in world units; another machine's, elsewhere, never) is its
// mascot exactly as its row in the Bots tab draws it (chats.js botLook: the same seed, shape, colour and face, so it is
// the same character there and here), about 34 px and growing and shrinking with the zoom (24 to 52), centred on its
// spot, its name on a small frosted pill under it (with how many it watches); not running, only its name is quieter. A thin dashed line in its colour (fixed alpha) runs
// to each conversation it watches (watches[]) whose orb is on the map, and its hover lists them ("Watching: Fix login ·
// Answer its questions"). An older server has no map or watches: no bots on the map then.
// Drag one (pointer capture, so the map under it never pans): it follows the pointer and stays where it is let go
// (ui.placeBot, world units). Let go on a conversation's orb (not a bot's, not a new one), it watches that
// conversation too (ui.watchBot, job 'report', unless it watches it already) and sits just beside the orb on the side
// it came from, not over it; a dashed ring in its colour marks that orb while the bot is held over it. A move under 4 px is a click, which
// does nothing; a double-click opens its chat in the Bots tab (ui.openBotChat). Right-click: the shell's bot menu
// (ui.contextMenu({ kind: 'bot', id })). Its new spot holds until the state says so (or 5 s), so it never jumps back.
// House rules (map-overlay.js): nothing pulses, blinks or lights up on events, colours and alphas are fixed; the
// mascot's own slow breathing (mascot.css, transform only) is all that moves, and the short "got it" hop its Bots
// row does when Henry messages it (chats.js ackBot sends fv-bot-ack; mascot.js mascotAck). The DOM is written only
// when something changed: a bot's place, size, look, name or watches, the lines when an end moved.

import { mascotSVG, mascotState, mascotAck } from './mascot.js';
import { C, acctColor, isAcct } from './cards.js';
import { botLook } from './chats.js';

const UI = "'Segoe UI Variable Text', 'Segoe UI', system-ui, sans-serif";
const CSS_UI = `var(--font-ui, ${UI})`;
const SIZE = 34, MIN = 24, MAX = 52;      // px: the mascot at the map's own scale, and its limits with the zoom
const CLICK_PX = 4, DROP_PAD = 14;        // a move under this is a click; an orb takes a drop this far past its edge
const BESIDE = 8, NAME_H = 22;            // px between an orb and a bot dropped on it; its name pill's height
const HOLD_MS = 5000;                     // a dropped bot's spot holds this long at most while the state catches up
const LINE_ALPHA = 0.5;
const HEX6 = /^#[0-9a-f]{6}$/i, HEX = /^#[0-9a-f]{3,8}$/i;
// the jobs a bot can watch with (the server's names), as the menus and the hover say them
export const BOT_JOBS = [['report', 'Tell me when it needs me'], ['answer', 'Answer its questions'], ['review', "Review its work when it's done"]];
const JOB_LABEL = Object.fromEntries(BOT_JOBS);
export const jobLabel = (j) => JOB_LABEL[j] || String(j || '');

const STYLE = `
.fvb-bot{position:absolute;left:0;top:0;pointer-events:auto;cursor:grab;touch-action:none;user-select:none;-webkit-user-select:none}
.fvb-bot.drag{cursor:grabbing}
.fvb-face{width:100%;height:100%;filter:drop-shadow(0 3px 7px rgba(0,0,0,0.45))}
.fvb-face svg{width:100%;height:100%;display:block}
.fvb-name{position:absolute;left:50%;top:100%;margin-top:3px;transform:translateX(-50%);display:flex;gap:5px;align-items:center;
  max-width:170px;padding:2px 7px;border-radius:999px;font:600 11px/1.25 ${CSS_UI};white-space:nowrap;
  background:rgba(18,21,32,0.72);border:1px solid rgba(255,255,255,0.07);color:${C.text}}
.fvb-name .nm{overflow:hidden;text-overflow:ellipsis}
.fvb-name .w{color:${C.dim};font-weight:600}
.fvb-bot.off .fvb-name{color:${C.dim}}
.fvb-bot:hover .fvb-name{border-color:rgba(255,255,255,0.18)}
`;

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const sessionsOf = (st) => (st && (st.allSessions || st.sessions)) || [];
// the bots that can be on the map: this machine's own (another machine's are drawn there)
export const ownBots = (st) => (st && Array.isArray(st.bots) ? st.bots : []).filter((b) => b && typeof b.id === 'string' && b.id && !b.elsewhere);
export const onMap = (b) => !!(b && b.map && Number.isFinite(b.map.x) && Number.isFinite(b.map.y));
export const watchesOf = (b) => (b && Array.isArray(b.watches) ? b.watches.filter((w) => w && typeof w.id === 'string') : []);
// a bot's conversation now (its convId), from the state the map drew
const botSession = (b, st) => (b && b.convId ? sessionsOf(st).find((s) => s.id === b.convId) || null : null);
// its colour, as its Bots row wears it (chats.js botLook); without a row, as that picks it: its own, else its
// conversation's workspace, else its account's, else cyan
export function botColor(b, st) {
  const look = b ? botLook(st, b.id) : null;
  if (look) return look.color;
  if (b && typeof b.color === 'string' && HEX6.test(b.color)) return b.color;
  const s = botSession(b, st);
  const r = s && s.repo && s.repo.color;
  if (HEX.test(String(r || ''))) return r;
  const a = (s && s.account) || (b && b.account);
  return isAcct(a) ? acctColor(a) : C.cyan;
}
// its mascot as its Bots row draws it (the menus' "Add bot ▸", "Have a bot watch it ▸"), size px
export function botMascot(b, st, size = 20) {
  const look = b ? botLook(st, b.id) : null;
  if (look) return look.svg(size);
  return mascotSVG(`bot:${(b && b.id) || ''}`, { state: 'idle', color: botColor(b, st), size, shape: (b && b.shape) || undefined });
}
export const botName = (b) => (b && typeof b.name === 'string' && b.name) || String((b && b.id) || '').slice(0, 8);
// a watched conversation's name: the server's, else the listed conversation's, else its id's start
export function watchName(w, st) {
  if (w && typeof w.name === 'string' && w.name) return w.name;
  const s = w ? sessionsOf(st).find((x) => x.id === w.id) : null;
  return (s && s.name) || String((w && w.id) || '').slice(0, 8);
}

export function mountMapBots(layer, api) {
  const B = {
    dead: false,
    els: new Map(),          // bot id -> { el, face, name, faceSig, nameSig, pos, size, tip }
    drag: null,              // { id, pid, x0, y0, ox, oy, moved, sx, sy, target }
    held: new Map(),         // bot id -> { x, y, at }: where it was dropped, until the state has it
    lineSig: '',
  };
  const call = (name, ...a) => { try { return typeof api[name] === 'function' ? api[name](...a) : undefined; } catch (e) { console.error(e); return undefined; } };
  const shell = () => call('ui') || {};
  const tell = (name, ...a) => { const u = shell(); try { return typeof u[name] === 'function' ? u[name](...a) : undefined; } catch (e) { console.error(e); return undefined; } };

  const style = document.createElement('style');
  style.textContent = STYLE;
  layer.appendChild(style);
  const lines = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  lines.setAttribute('aria-hidden', 'true');
  lines.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;overflow:visible;pointer-events:none';
  layer.appendChild(lines);

  const local = (e) => { const r = layer.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  const sizeOf = (cam) => Math.round(clamp(SIZE * (Number(cam.k) || Number(cam.zoom) || 1), MIN, MAX));
  // the conversation orb a bot let go at (sx, sy) would watch, or null: the nearest one in reach, not new, not a bot's
  function orbAt(sx, sy) {
    const st = call('state');
    const byId = new Map(sessionsOf(st).map((s) => [s.id, s]));
    let best = null, bd = Infinity;
    for (const n of call('nodes') || []) {
      if (!n || n.kind !== 'session' || !n.sid || /^new-/.test(n.sid) || typeof n.sx !== 'number') continue;
      const s = byId.get(n.sid);
      if (s && (s.pending || s.bot || s.demo)) continue;
      const d = Math.hypot(sx - n.sx, sy - n.sy);
      if (d <= (n.r || 6) + DROP_PAD && d < bd) { bd = d; best = n; }
    }
    return best;
  }

  function botEl(id) {
    let m = B.els.get(id);
    if (m) return m;
    const el = document.createElement('div');
    el.className = 'fvb-bot';
    el.dataset.bot = id;
    const face = document.createElement('div');
    face.className = 'fvb-face';
    const name = document.createElement('div');
    name.className = 'fvb-name';
    el.append(face, name);
    m = { el, face, name, faceSig: '', nameSig: '', pos: '', size: 0, tip: '', off: null };
    // its pointer events stay its own: the map under it never pans, picks or opens its menu
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault(); e.stopPropagation();
      const [px, py] = local(e);
      const c = m.at || [px, py];
      B.drag = { id, pid: e.pointerId, x0: e.clientX, y0: e.clientY, ox: px - c[0], oy: py - c[1], from: [c[0], c[1]], moved: false, sx: c[0], sy: c[1], target: null };
      try { el.setPointerCapture(e.pointerId); } catch { /* old browser */ }
    });
    el.addEventListener('pointermove', (e) => {
      const d = B.drag;
      if (!d || d.id !== id || d.pid !== e.pointerId) return;
      e.stopPropagation();
      if (!d.moved && Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < CLICK_PX) return;
      if (!d.moved) { d.moved = true; el.classList.add('drag'); }
      const [px, py] = local(e);
      d.sx = px - d.ox; d.sy = py - d.oy;
      d.target = orbAt(px, py);
      draw();
    });
    const up = (e, cancel) => {
      const d = B.drag;
      if (!d || d.id !== id || d.pid !== e.pointerId) return;
      e.stopPropagation();
      B.drag = null;
      el.classList.remove('drag');
      try { el.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
      if (!cancel && d.moved) drop(id, d, local(e));
      draw();
    };
    el.addEventListener('pointerup', (e) => up(e, false));
    el.addEventListener('pointercancel', (e) => up(e, true));
    el.addEventListener('dblclick', (e) => { e.preventDefault(); e.stopPropagation(); tell('openBotChat', id); });
    el.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); tell('contextMenu', { kind: 'bot', id }, e.clientX, e.clientY); });
    for (const ev of ['mousedown', 'click', 'auxclick']) el.addEventListener(ev, (e) => { e.stopPropagation(); if (ev === 'mousedown') e.preventDefault(); });
    layer.appendChild(el);
    B.els.set(id, m);
    return m;
  }

  // let go: on an orb it watches that conversation (unless it does already) and sits beside it; anywhere else it
  // just stays there
  function drop(id, d, [px, py]) {
    const cam = call('camera');
    if (!cam || typeof cam.toWorld !== 'function') return;
    let sx = d.sx, sy = d.sy;
    const orb = orbAt(px, py);
    const st = call('state');
    const b = ownBots(st).find((x) => x.id === id);
    if (orb) {
      // on the side it came from (straight under the orb when it came from right there); above the orb, its name
      // pill sits between them, so it keeps that much further off
      let ux = d.from[0] - orb.sx, uy = d.from[1] - orb.sy;
      const len = Math.hypot(ux, uy);
      if (len < 1) { ux = 0; uy = 1; } else { ux /= len; uy /= len; }
      const gap = (orb.r || 6) + sizeOf(cam) / 2 + BESIDE + (uy < -0.3 ? NAME_H : 0);
      sx = orb.sx + ux * gap; sy = orb.sy + uy * gap;
      if (!watchesOf(b).some((w) => w.id === orb.sid)) tell('watchBot', id, orb.sid, 'report');
    }
    const w = cam.toWorld(sx, sy);
    const wx = w.x !== undefined ? w.x : w[0], wy = w.y !== undefined ? w.y : w[1];
    if (!Number.isFinite(wx) || !Number.isFinite(wy)) return;
    B.held.set(id, { x: wx, y: wy, at: performance.now() });
    tell('placeBot', id, wx, wy);
  }

  // where a bot is drawn: held by the pointer, else where it was just dropped (until the state has it), else its spot
  function spotOf(b, cam, now) {
    const d = B.drag;
    if (d && d.id === b.id && d.moved) return [d.sx, d.sy];
    const h = B.held.get(b.id);
    if (h) {
      const same = onMap(b) && Math.abs(b.map.x - h.x) < 0.5 && Math.abs(b.map.y - h.y) < 0.5;
      if (same || now - h.at > HOLD_MS) B.held.delete(b.id);
      else { const p = cam.toScreen(h.x, h.y); return [p[0], p[1]]; }
    }
    if (!onMap(b)) return null;
    const p = cam.toScreen(b.map.x, b.map.y);
    return [p[0], p[1]];
  }

  function draw(now = performance.now()) {
    if (B.dead) return;
    const cam = call('camera');
    if (!cam || !cam.W || typeof cam.toScreen !== 'function') return;
    const st = call('state');
    // a replay draws the map as it was: no bots then
    const bots = st && !st.replay ? ownBots(st) : [];
    const size = sizeOf(cam);
    const orbs = new Map();
    for (const n of call('nodes') || []) if (n && n.kind === 'session' && n.sid && typeof n.sx === 'number') orbs.set(n.sid, n);
    const seen = new Set();
    let svg = '';
    for (const b of bots) {
      const at = spotOf(b, cam, now);
      if (!at) continue;
      seen.add(b.id);
      const m = botEl(b.id);
      m.at = at;
      const live = !!b.live;
      const ws = watchesOf(b);
      // the face, colour and shape its Bots row has (chats.js botLook); without a row, worked out the same way
      const look = botLook(st, b.id);
      const color = look ? look.color : botColor(b, st);
      const s = look ? null : botSession(b, st);
      const face = look ? look.face : live && s ? mascotState(s) : 'idle';
      const shape = look ? look.shape : b.shape || null;
      const faceSig = [face, color, shape || ''].join('|');
      if (faceSig !== m.faceSig) {
        m.faceSig = faceSig;
        m.face.innerHTML = look ? look.svg(40) : mascotSVG(`bot:${b.id}`, { state: face, color, size: 40, shape: shape || undefined });
      }
      if (m.off !== !live) { m.off = !live; m.el.classList.toggle('off', !live); }
      const name = botName(b);
      const nameSig = name + '\u0001' + ws.length;
      if (nameSig !== m.nameSig) {
        m.nameSig = nameSig;
        m.name.innerHTML = `<span class="nm">${esc(name)}</span>${ws.length ? `<span class="w">· ${ws.length}</span>` : ''}`;
      }
      const tip = [`${name}${live ? '' : ' (not running)'}`,
        ...(ws.length ? ws.map((w) => `Watching: ${watchName(w, st)} · ${jobLabel(w.job)}${w.last && w.last.what ? ` (last: ${w.last.what})` : ''}`) : ['Watching nothing yet']),
        'Drag it onto a conversation to watch it · right-click for more'].join('\n');
      if (tip !== m.tip) { m.tip = tip; m.el.title = tip; }
      if (size !== m.size) { m.size = size; m.el.style.width = m.el.style.height = size + 'px'; }
      const pos = `translate(${Math.round(at[0] - size / 2)}px,${Math.round(at[1] - size / 2)}px)`;
      if (pos !== m.pos) { m.pos = pos; m.el.style.transform = pos; }
      // a dashed line to each watched conversation on the map, from the mascot's edge to the orb's
      for (const w of ws) {
        const n = orbs.get(w.id);
        if (!n) continue;
        const dx = n.sx - at[0], dy = n.sy - at[1], len = Math.hypot(dx, dy);
        const a = size / 2 + 2, z = (n.r || 6) + 3;
        if (len <= a + z) continue;
        const ux = dx / len, uy = dy / len;
        svg += `<line x1="${(at[0] + ux * a).toFixed(1)}" y1="${(at[1] + uy * a).toFixed(1)}" x2="${(n.sx - ux * z).toFixed(1)}" y2="${(n.sy - uy * z).toFixed(1)}" stroke="${esc(color)}" stroke-opacity="${LINE_ALPHA}" stroke-width="1.3" stroke-dasharray="4 4" stroke-linecap="round"/>`;
      }
    }
    // the orb a held bot would watch: a dashed ring in the bot's colour
    const d = B.drag;
    if (d && d.moved && d.target && typeof d.target.sx === 'number') {
      const b = bots.find((x) => x.id === d.id);
      svg += `<circle cx="${d.target.sx.toFixed(1)}" cy="${d.target.sy.toFixed(1)}" r="${((d.target.r || 6) + 6).toFixed(1)}" fill="none" stroke="${esc(botColor(b, st))}" stroke-opacity="0.8" stroke-width="1.5" stroke-dasharray="3 3"/>`;
    }
    if (svg !== B.lineSig) { B.lineSig = svg; lines.innerHTML = svg; }
    for (const [id, m] of B.els) if (!seen.has(id)) { m.el.remove(); B.els.delete(id); if (B.drag && B.drag.id === id) B.drag = null; }
  }

  // Henry messaged a bot (chats.js ackBot): its mascot here hops as its row does, if it is on the map
  const onAck = (e) => {
    const key = e && e.detail && e.detail.key;
    const m = typeof key === 'string' && key.startsWith('bot:') ? B.els.get(key.slice(4)) : null;
    if (m) mascotAck(m.face);
  };
  window.addEventListener('fv-bot-ack', onAck);

  function destroy() {
    if (B.dead) return;
    B.dead = true;
    window.removeEventListener('fv-bot-ack', onAck);
    for (const m of B.els.values()) m.el.remove();
    B.els.clear();
    lines.remove();
    style.remove();
  }
  // for tests (?fixture=1 or ?debug=1): each bot on the map, where it is drawn
  try {
    if (/[?&](fixture|debug)=1/.test(location.search)) {
      window.__mapBots = () => [...B.els.entries()].map(([id, m]) => ({ id, at: m.at, size: m.size, rect: m.el.getBoundingClientRect().toJSON(), name: m.name.textContent, title: m.tip }));
    }
  } catch { /* no location */ }
  return { frame: (now) => draw(typeof now === 'number' ? now : performance.now()), destroy };
}
