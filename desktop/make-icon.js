'use strict';
// Writes desktop/fleet-view.ico from icon.js (run after changing the drawing: node desktop/make-icon.js).
// Pass a folder to also write a PNG per size there, for a look at each one.
const fs = require('fs');
const path = require('path');
const { iconPng, icoBuffer, ICO_SIZES } = require('./icon');

const out = path.join(__dirname, 'fleet-view.ico');
fs.writeFileSync(out, icoBuffer());
console.log(`wrote ${out}`);
const dir = process.argv[2];
if (dir) {
  fs.mkdirSync(dir, { recursive: true });
  for (const n of ICO_SIZES) fs.writeFileSync(path.join(dir, `icon-${n}.png`), iconPng(n));
  for (const n of [16, 20, 24, 32]) fs.writeFileSync(path.join(dir, `tray-${n}.png`), iconPng(n, { tile: false }));
  console.log(`wrote PNGs to ${dir}`);
}
