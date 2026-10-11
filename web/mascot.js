// Mascots: the small blob character each contact wears in the Chats tab (chats.js). A shape picked from a stable
// seed (hexagon, drop, round, pill, triangle, ...), filled with a colour, with a face that shows the state:
// eyes that look about while it works, a "?" when it needs you, X eyes on an error, ^ ^ when it is done,
// half-shut when idle. House rule: nothing blinks, colours stay steady, motion keeps constant brightness, and
// with prefers-reduced-motion it holds still (mascot.css).
//
// CONTRACT (chats.js and chats-model.js build on it; keep these names and signatures):
//   SHAPES                  the shape names, in order
//   shapeFor(seed)          a shape from SHAPES, the same for the same seed
//   mascotState(s)          a conversation or contact ({ state, kind? }) -> 'working' | 'needs' | 'error' | 'done' | 'idle' | 'new'
//   mascotSVG(seed, o)      the SVG markup (a string, safe to put in innerHTML); o: { state, color, size = 40, shape }
//                           The root is <svg class="mascot m-<state>" ...> so mascot.css can animate it.

export const SHAPES = ['hex', 'drop', 'round', 'pill', 'tri', 'square', 'star'];

function hash(s) {
  let h = 2166136261;
  for (const c of String(s || '')) { h ^= c.codePointAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

export const shapeFor = (seed) => SHAPES[hash(seed) % SHAPES.length];

export function mascotState(s) {
  const st = s && s.state;
  if (st === 'ERROR') return 'error';
  if (st === 'ASKING' || st === 'QUESTION' || st === 'STALLED') return 'needs';
  if (st === 'WORKING' || st === 'AGENTS' || st === 'HANDOFF') return 'working';
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
const HEX = roundPoly([0, 1, 2, 3, 4, 5].map((k) => polar(20, 20, 19.5, -90 + k * 60)), [5]);
const STAR = roundPoly([0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((k) => polar(20, 21.2, k % 2 ? 11.8 : 20.5, -90 + k * 36)), [5.5, 6]);
const TRI = roundPoly([[20, 3.5], [38, 35], [2, 35]], [6.5]);
// per shape: outline path, and the face (centre y, half the gap between the eyes)
const BODY = {
  hex: { d: HEX, fy: 18.5, gap: 5.5 },
  drop: { d: 'M20 2.5C23.5 8 34.5 15.5 34.5 25A14.5 14.5 0 0 1 5.5 25C5.5 15.5 16.5 8 20 2.5Z', fy: 23, gap: 5.5 },
  round: { d: 'M20 2.5A17.5 17.5 0 1 1 19.99 2.5Z', fy: 18, gap: 5.5 },
  pill: { d: 'M13 8.5H27A11.5 11.5 0 0 1 27 31.5H13A11.5 11.5 0 0 1 13 8.5Z', fy: 18.6, gap: 6.5 },
  tri: { d: TRI, fy: 25, gap: 4.8 },
  square: { d: 'M15 3H25C34 3 37 6 37 15V25C37 34 34 37 25 37H15C6 37 3 34 3 25V15C3 6 6 3 15 3Z', fy: 18, gap: 5.8 },
  star: { d: STAR, fy: 20.4, gap: 5 },
};

const INK = '#1b1b22';
const NUM = String.raw`[0-9]+(?:\.[0-9]+)?%?`;
const COLOR_RE = new RegExp(String.raw`^(?:#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})|(?:rgb|hsl)a?\(\s*${NUM}\s*[, ]\s*${NUM}\s*[, ]\s*${NUM}(?:\s*[,/]\s*${NUM})?\s*\))$`, 'i');
const STATES = ['working', 'needs', 'error', 'done', 'idle', 'new'];
let uid = 0;

// one eye at (x, y); l = look offset for the highlight
function eye(state, x, y) {
  if (state === 'error') return `<path d="M${x - 2.1} ${y - 2.1}L${x + 2.1} ${y + 2.1}M${x + 2.1} ${y - 2.1}L${x - 2.1} ${y + 2.1}" stroke="${INK}" stroke-width="1.9" stroke-linecap="round" fill="none"/>`;
  if (state === 'done') return `<path d="M${x - 2.8} ${y + 1.2}Q${x} ${y - 3.2} ${x + 2.8} ${y + 1.2}" stroke="${INK}" stroke-width="1.9" stroke-linecap="round" fill="none"/>`;
  if (state === 'idle') return `<path d="M${x - 2.1} ${y - 0.8}H${x + 2.1}V${y + 0.4}A2.1 2.7 0 0 1 ${x - 2.1} ${y + 0.4}Z" fill="${INK}"/><circle cx="${x - 0.6}" cy="${y + 0.5}" r="0.55" fill="#fff"/>`;
  if (state === 'new') return `<circle cx="${x}" cy="${y}" r="3.2" fill="${INK}"/><circle cx="${x - 1}" cy="${y - 1.1}" r="1" fill="#fff"/>`;
  return `<ellipse cx="${x}" cy="${y}" rx="2.1" ry="3" fill="${INK}"/><circle cx="${x - 0.7}" cy="${y - 1.2}" r="0.8" fill="#fff"/>`;
}

const BUBBLE = `<g transform="translate(32.6 7.4) scale(0.88)"><path d="M-4.2 4.2L-6.2 8.2L-0.8 5.6Z" fill="#fff"/><circle r="6.4" fill="#fff"/>`
  + `<path d="M-2 -1.7A2.1 2.1 0 1 1 1.1 0.2C0.2 0.7 0 1.2 0 2" stroke="${INK}" stroke-width="1.5" stroke-linecap="round" fill="none"/><circle cy="3.9" r="0.85" fill="${INK}"/></g>`;
const SPARKLE = `<path transform="translate(31.5 8.5)" d="M0-5Q0.8-0.8 5 0Q0.8 0.8 0 5Q-0.8 0.8-5 0Q-0.8-0.8 0-5Z" fill="#fff4b8"/>`;

export function mascotSVG(seed, o = {}) {
  o = o || {};
  const size = Math.max(12, Math.min(160, Number(o.size) || 40));
  const color = COLOR_RE.test(String(o.color || '').trim()) ? String(o.color).trim() : '#58a6ff';
  const state = STATES.includes(o.state) ? o.state : 'idle';
  const shape = SHAPES.includes(o.shape) ? o.shape : shapeFor(seed);
  const b = BODY[shape], g = `mg${++uid}`;
  // needs: the eyes look up and to the right, toward the bubble
  const ox = state === 'needs' ? 1.3 : 0, oy = state === 'needs' ? -1.6 : 0;
  const face = `<g class="m-eyes"><g transform="translate(${ox} ${oy})">${eye(state, 20 - b.gap, b.fy)}${eye(state, 20 + b.gap, b.fy)}</g></g>`;
  return `<svg class="mascot m-${state}" width="${size}" height="${size}" viewBox="0 0 40 40" aria-hidden="true">`
    + `<defs><linearGradient id="${g}" x1="0" y1="0" x2="0" y2="1"><stop offset="0.4" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.22"/></linearGradient></defs>`
    + `<g class="m-body"><path d="${b.d}" fill="${color}"/><path d="${b.d}" fill="url(#${g})"/>${face}</g>`
    + (state === 'needs' ? BUBBLE : state === 'new' ? SPARKLE : '') + '</svg>';
}
