'use strict';
// Fleet View's icon, drawn in code (no image tools needed): the ember diamond that has always been the tray
// mark, on a dark rounded tile, with an orbit ring and three small dots, the sessions around it.
//   iconPng(size, { tile })  PNG buffer; tile: false draws it on transparent (the tray), no tile behind it
//   icoBuffer(sizes)         a Windows .ico holding a PNG per size (make-icon.js writes desktop/fleet-view.ico)
// Small sizes drop what would turn to mush: under 24 px no ring, just the diamond and the dots.
const zlib = require('zlib');

const EMBER = [255, 106, 43], GOLD = [255, 194, 74];
const DOT = [232, 235, 247], RING = [201, 206, 230];
const TILE_TOP = [30, 33, 47], TILE_BOTTOM = [13, 15, 22];

const mix = (a, b, t) => [0, 1, 2].map((i) => a[i] + (b[i] - a[i]) * t);

// signed distance to a rounded box centred at (0.5, 0.5), half size h, corner radius r (negative inside)
function roundBox(x, y, h, r) {
  const qx = Math.abs(x - 0.5) - h + r, qy = Math.abs(y - 0.5) - h + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

function shapes(size, tile) {
  const px = 1 / size;
  const small = size < 24;
  const scale = tile ? 1 : 1.18; // without the tile the mark can use the whole square
  const k = (v) => v * scale;
  const dia = small ? k(0.25) : k(0.19);
  const ringR = k(0.335), ringW = Math.max(k(0.022), px * 1.1);
  const dotR = Math.max(small ? k(0.085) : k(0.058), px * 1.2);
  const dotAt = small ? k(0.36) : ringR;
  const dots = [-90, 30, 150].map((a) => [0.5 + dotAt * Math.cos((a * Math.PI) / 180), 0.5 + dotAt * Math.sin((a * Math.PI) / 180)]);
  const gap = dotR + Math.max(k(0.03), px);
  return { px, small, dia, ringR, ringW, dotR, dots, gap };
}

// colour (straight alpha, 0..1) of one sample point
function sample(x, y, s, tile) {
  let r = 0, g = 0, b = 0, a = 0;
  const over = (c, alpha) => {
    if (alpha <= 0) return;
    const na = alpha + a * (1 - alpha);
    r = (c[0] * alpha + r * a * (1 - alpha)) / na;
    g = (c[1] * alpha + g * a * (1 - alpha)) / na;
    b = (c[2] * alpha + b * a * (1 - alpha)) / na;
    a = na;
  };
  if (tile) {
    const d = roundBox(x, y, 0.47, 0.2);
    if (d > 0) return [0, 0, 0, 0];
    over(mix(TILE_TOP, TILE_BOTTOM, y), 1);
    if (d > -Math.max(0.012, s.px)) over([255, 255, 255], 0.1); // a faint edge so it holds on a dark taskbar
  }
  // the orbit ring, broken around each dot
  if (!s.small) {
    const dr = Math.abs(Math.hypot(x - 0.5, y - 0.5) - s.ringR);
    const nearDot = s.dots.some(([cx, cy]) => Math.hypot(x - cx, y - cy) < s.gap);
    if (dr < s.ringW / 2 && !nearDot) over(RING, 0.42);
  }
  // the ember diamond, ember at the top left to gold at the bottom right
  if (Math.abs(x - 0.5) + Math.abs(y - 0.5) <= s.dia) {
    const t = Math.min(1, Math.max(0, (x - 0.5 + y - 0.5) / (4 * s.dia) + 0.5));
    over(mix(EMBER, GOLD, t), 1);
  }
  for (const [cx, cy] of s.dots) if (Math.hypot(x - cx, y - cy) <= s.dotR) over(DOT, 1);
  return [r, g, b, a];
}

function crcTable() {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
}
const CRC = crcTable();
function crc32(buf) { let c = 0xffffffff; for (const v of buf) c = CRC[(c ^ v) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function iconPng(size, { tile = true } = {}) {
  const s = shapes(size, tile);
  const N = size <= 32 ? 8 : 4; // samples per side of a pixel: smooth edges at every size
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < N; sy++) for (let sx = 0; sx < N; sx++) {
        const c = sample((x + (sx + 0.5) / N) / size, (y + (sy + 0.5) / N) / size, s, tile);
        r += c[0] * c[3]; g += c[1] * c[3]; b += c[2] * c[3]; a += c[3];
      }
      const o = y * (size * 4 + 1) + 1 + x * 4;
      if (a > 0) { raw[o] = Math.round(r / a); raw[o + 1] = Math.round(g / a); raw[o + 2] = Math.round(b / a); }
      raw[o + 3] = Math.round((255 * a) / (N * N));
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256];

function icoBuffer(sizes = ICO_SIZES) {
  const pngs = sizes.map((n) => iconPng(n));
  const head = Buffer.alloc(6 + 16 * sizes.length);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(sizes.length, 4);
  let offset = head.length;
  sizes.forEach((n, i) => {
    const e = 6 + 16 * i;
    head[e] = n >= 256 ? 0 : n; head[e + 1] = n >= 256 ? 0 : n; // 0 means 256
    head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(pngs[i].length, e + 8); head.writeUInt32LE(offset, e + 12);
    offset += pngs[i].length;
  });
  return Buffer.concat([head, ...pngs]);
}

module.exports = { iconPng, icoBuffer, ICO_SIZES };
