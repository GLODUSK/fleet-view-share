// Mascots: the small blob character each contact wears in the Bots tab (chats.js). A shape (hexagon, drop, round,
// pill, triangle, ..., clover, flower, heart): the bot's own pick when it has one (state.bots shape, bots.js), else one
// from a stable seed, filled with a colour, with big eyes that show the state: open eyes that look about while it
// works, eyes turned up with three little dots while it thinks about a fresh message (no tool has run yet), a "?"
// when it needs you, X eyes on an error, ^ ^ when it is done, half-shut when idle.
// It is alive in every state (mascot.css): the body breathes slowly (bobs while it works) and the eyes look around
// now and then, each mascot out of step with the others (m-d0..m-d5, from the seed). mascotAck(el) gives the one in
// el a short hop, the "got it" when Henry sends that bot a message.
// House rule: nothing blinks (no eye closes and opens; eye motion is a translate only), colours stay steady, motion
// is transform only, and with prefers-reduced-motion it holds still. The phone app draws mascotSVG's markup as it is
// (react-native-svg, no CSS): it stays plain SVG, and every motion lives in mascot.css.
//
// CONTRACT (chats.js, chats-model.js and the phone app build on it; keep these names and signatures):
//   SHAPES                  the shape names, in order (bots.js keeps the same list to check a bot's pick)
//   shapeFor(seed)          a shape from SHAPES, the same for the same seed (the first seven only: a seed's pick never
//                           changed when shapes were added)
//   mascotState(s)          a conversation or contact ({ state, turnStart?, lastAction?, running? }) ->
//                           'working' | 'thinking' | 'needs' | 'error' | 'done' | 'idle' | 'new'
//                           'thinking': WORKING, with no tool run since its turn began (turnStart)
//   mascotSVG(seed, o)      the SVG markup (a string, safe to put in innerHTML); o: { state, color, size = 40, shape }
//                           The root is <svg class="mascot m-<state> m-d<n>" ...> so mascot.css can animate it. The
//                           same call gives the same string (its gradient id comes from what it draws), so a list
//                           drawn again unchanged is not rewritten and its motion does not restart.
//   mascotAck(el)           the acknowledge hop on the mascot in el (or el itself); a no-op without a DOM

export const SHAPES = ['hex', 'drop', 'round', 'pill', 'tri', 'square', 'star', 'clover', 'flower', 'heart'];
const SEEDED = 7; // shapeFor picks from the first seven, as it did before the rest were added

function hash(s) {
  let h = 2166136261;
  for (const c of String(s || '')) { h ^= c.codePointAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

export const shapeFor = (seed) => SHAPES[hash(seed) % SEEDED];

// WORKING with nothing run since its turn began: Claude is still reading the message and making up its mind
function thinking(s) {
  const start = Number(s.turnStart);
  if (s.state !== 'WORKING' || !Number.isFinite(start) || start <= 0) return false;
  if (Array.isArray(s.running) && s.running.length) return false;
  const a = s.lastAction;
  return !(a && Number(a.t) >= start);
}

export function mascotState(s) {
  const st = s && s.state;
  if (st === 'ERROR') return 'error';
  if (st === 'ASKING' || st === 'QUESTION' || st === 'STALLED') return 'needs';
  if (st === 'WORKING' || st === 'AGENTS' || st === 'HANDOFF') return thinking(s) ? 'thinking' : 'working';
  if (st === 'NEW') return 'new';
  if (st === 'DONE') return 'done';
  return 'idle';
}

// Shape outlines in a 40x40 box, all about the same visual weight. Polygons get soft corners (roundPoly), built once.
function roundPoly(pts, rs) {
  const n = pts.length, out = [];
  for (let i = 0; i < n; i++) {
    const p = pts[(i + n - 1) % n], v = pts[i], q = pts[(i + 1) % n];
    const lp = Math.hypot(p[0] - v[0], p[1] - v[1]), lq = Math.hypot(q[0] - v[0], q[1] - v[1]);
    const r = rs[i % rs.length], dp = Math.min(r, lp / 2.2), dq = Math.min(r, lq / 2.2);
    const a = [v[0] + (p[0] - v[0]) * dp / lp, v[1] + (p[1] - v[1]) * dp / lp];
    const b = [v[0] + (q[0] - v[0]) * dq / lq, v[1] + (q[1] - v[1]) * dq / lq];
    out.push(`${i ? 'L' : 'M'}${a[0].toFixed(2)} ${a[1].toFixed(2)}Q${v[0].toFixed(2)} ${v[1].toFixed(2)} ${b[0].toFixed(2)} ${b[1].toFixed(2)}`);
  }
  return out.join('') + 'Z';
}
const polar = (cx, cy, r, deg) => [cx + r * Math.cos(deg * Math.PI / 180), cy + r * Math.sin(deg * Math.PI / 180)];
// circles drawn the same way round in one path: with the default nonzero fill they read as one blob, not overlaps
const circle = ([cx, cy], r) => `M${(cx - r).toFixed(2)} ${cy.toFixed(2)}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0Z`;
const HEX = roundPoly([0, 1, 2, 3, 4, 5].map((k) => polar(20, 20, 19.5, -90 + k * 60)), [5]);
const STAR = roundPoly([0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((k) => polar(20, 21.2, k % 2 ? 11.8 : 20.5, -90 + k * 36)), [5.5, 6]);
const TRI = roundPoly([[20, 3.5], [38, 35], [2, 35]], [6.5]);
const CLOVER = [0, 1, 2, 3].map((k) => circle(polar(20, 20, 8.6, -90 + k * 90), 9.6)).join('') + circle([20, 20], 10);
const FLOWER = [0, 1, 2, 3, 4, 5].map((k) => circle(polar(20, 20, 11.6, -90 + k * 60), 7.2)).join('') + circle([20, 20], 12.2);
// per shape: outline path, and the face (centre y, half the gap between the eyes)
const BODY = {
  hex: { d: HEX, fy: 18.5, gap: 5.5 },
  drop: { d: 'M20 2.5C23.5 8 34.5 15.5 34.5 25A14.5 14.5 0 0 1 5.5 25C5.5 15.5 16.5 8 20 2.5Z', fy: 23, gap: 5.5 },
  round: { d: 'M20 2.5A17.5 17.5 0 1 1 19.99 2.5Z', fy: 18, gap: 5.5 },
  pill: { d: 'M13 8.5H27A11.5 11.5 0 0 1 27 31.5H13A11.5 11.5 0 0 1 13 8.5Z', fy: 18.6, gap: 6.5 },
  tri: { d: TRI, fy: 25, gap: 4.8 },
  square: { d: 'M15 3H25C34 3 37 6 37 15V25C37 34 34 37 25 37H15C6 37 3 34 3 25V15C3 6 6 3 15 3Z', fy: 18, gap: 5.8 },
  star: { d: STAR, fy: 20.4, gap: 5 },
  clover: { d: CLOVER, fy: 19.6, gap: 5.2 },
  flower: { d: FLOWER, fy: 19.6, gap: 5 },
  heart: { d: 'M20 36C16.6 33.2 3 24.6 3 14.2C3 8.5 7.3 4 12.6 4C16 4 18.6 5.9 20 8.6C21.4 5.9 24 4 27.4 4C32.7 4 37 8.5 37 14.2C37 24.6 23.4 33.2 20 36Z', fy: 16.8, gap: 5.6 },
};

const INK = '#1b1b22';
const NUM = String.raw`[0-9]+(?:\.[0-9]+)?%?`;
const COLOR_RE = new RegExp(String.raw`^(?:#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})|(?:rgb|hsl)a?\(\s*${NUM}\s*[, ]\s*${NUM}\s*[, ]\s*${NUM}(?:\s*[,/]\s*${NUM})?\s*\))$`, 'i');
const STATES = ['working', 'thinking', 'needs', 'error', 'done', 'idle', 'new'];
const PHASES = 6; // m-d0..m-d5: how far into its motion each mascot starts (mascot.css)

// one eye at (x, y)
function eye(state, x, y) {
  if (state === 'error') return `<path d="M${x - 2.1} ${y - 2.1}L${x + 2.1} ${y + 2.1}M${x + 2.1} ${y - 2.1}L${x - 2.1} ${y + 2.1}" stroke="${INK}" stroke-width="1.9" stroke-linecap="round" fill="none"/>`;
  if (state === 'done') return `<path d="M${x - 2.8} ${y + 1.2}Q${x} ${y - 3.2} ${x + 2.8} ${y + 1.2}" stroke="${INK}" stroke-width="1.9" stroke-linecap="round" fill="none"/>`;
  if (state === 'idle') return `<path d="M${x - 2.1} ${y - 0.8}H${x + 2.1}V${y + 0.4}A2.1 2.7 0 0 1 ${x - 2.1} ${y + 0.4}Z" fill="${INK}"/><circle cx="${x - 0.6}" cy="${y + 0.5}" r="0.55" fill="#fff"/>`;
  if (state === 'new') return `<circle cx="${x}" cy="${y}" r="3.2" fill="${INK}"/><circle cx="${x - 1}" cy="${y - 1.1}" r="1" fill="#fff"/>`;
  // thinking: the highlight sits high, as the eyes look up at the dots
  if (state === 'thinking') return `<ellipse cx="${x}" cy="${y}" rx="2.1" ry="3" fill="${INK}"/><circle cx="${x + 0.4}" cy="${y - 1.6}" r="0.8" fill="#fff"/>`;
  return `<ellipse cx="${x}" cy="${y}" rx="2.1" ry="3" fill="${INK}"/><circle cx="${x - 0.7}" cy="${y - 1.2}" r="0.8" fill="#fff"/>`;
}

const BUBBLE = `<g transform="translate(32.6 7.4) scale(0.88)"><path d="M-4.2 4.2L-6.2 8.2L-0.8 5.6Z" fill="#fff"/><circle r="6.4" fill="#fff"/>`
  + `<path d="M-2 -1.7A2.1 2.1 0 1 1 1.1 0.2C0.2 0.7 0 1.2 0 2" stroke="${INK}" stroke-width="1.5" stroke-linecap="round" fill="none"/><circle cy="3.9" r="0.85" fill="${INK}"/></g>`;
const SPARKLE = `<path transform="translate(31.5 8.5)" d="M0-5Q0.8-0.8 5 0Q0.8 0.8 0 5Q-0.8 0.8-5 0Q-0.8-0.8 0-5Z" fill="#fff4b8"/>`;
// thinking: three dots rising to the top right, each in a group of its own so mascot.css can lift them in turn
const DOTS = [[28.6, 8.6, 1.15], [32, 5.6, 1.5], [35.8, 2.8, 1.85]]
  .map(([x, y, r], i) => `<g class="m-dot m-dot${i + 1}"><circle cx="${x}" cy="${y}" r="${r}" fill="#fff" stroke="${INK}" stroke-opacity="0.25" stroke-width="0.5"/></g>`).join('');

export function mascotSVG(seed, o = {}) {
  o = o || {};
  const size = Math.max(12, Math.min(160, Number(o.size) || 40));
  const color = COLOR_RE.test(String(o.color || '').trim()) ? String(o.color).trim() : '#58a6ff';
  const state = STATES.includes(o.state) ? o.state : 'idle';
  const shape = SHAPES.includes(o.shape) ? o.shape : shapeFor(seed);
  const b = BODY[shape];
  const h = hash(seed);
  // the same drawing, the same id: an id of its own per drawing, yet the same string each time it is drawn again
  const g = `mg${hash(`${shape}|${state}|${color}|${size}|${seed}`).toString(36)}`;
  // needs: the eyes look up and to the right, toward the bubble; thinking: up, toward the dots
  const ox = state === 'needs' ? 1.3 : state === 'thinking' ? 0.9 : 0;
  const oy = state === 'needs' ? -1.6 : state === 'thinking' ? -1.9 : 0;
  const face = `<g class="m-eyes"><g transform="translate(${ox} ${oy})">${eye(state, 20 - b.gap, b.fy)}${eye(state, 20 + b.gap, b.fy)}</g></g>`;
  return `<svg class="mascot m-${state} m-d${h % PHASES}" width="${size}" height="${size}" viewBox="0 0 40 40" aria-hidden="true">`
    + `<defs><linearGradient id="${g}" x1="0" y1="0" x2="0" y2="1"><stop offset="0.4" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.22"/></linearGradient></defs>`
    + `<g class="m-body"><path d="${b.d}" fill="${color}"/><path d="${b.d}" fill="url(#${g})"/>${face}</g>`
    + (state === 'needs' ? BUBBLE : state === 'new' ? SPARKLE : state === 'thinking' ? DOTS : '') + '</svg>';
}

// "Got it": a short hop and squash of the mascot in el (the class sits on el, so a mascot drawn again meanwhile
// hops too), cleared after the hop; reduced motion: mascot.css holds it still
const ACK_MS = 700;
export function mascotAck(el) {
  if (!el || !el.classList) return;
  el.classList.remove('m-ack');
  void el.offsetWidth; // a second send during the hop starts it again
  el.classList.add('m-ack');
  clearTimeout(el._mAck);
  el._mAck = setTimeout(() => el.classList.remove('m-ack'), ACK_MS);
}
