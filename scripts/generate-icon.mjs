// Generates assets/icon.png — the mark MCP clients show next to this server.
//
//   node scripts/generate-icon.mjs
//
// The output is committed, so this only needs running when the design changes.
// It exists rather than a checked-in binary alone because a generated icon can
// be reviewed as code: you can see what it draws instead of trusting a blob.
//
// Deliberately NOT the ELO logo. That is a registered trademark of ELO Digital
// Office GmbH and not ours to redistribute in a public repository. This draws a
// neutral filing-stack mark in the LOUPZ palette. To use an official icon
// instead, drop your own PNG at assets/icon.png — nothing else needs changing.
//
// No image library: a PNG is a signature plus three chunks, and node:zlib
// supplies both the deflate and the CRC.

import { deflateSync, crc32 } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = fileURLToPath(new URL('../assets/icon.png', import.meta.url));
const SIZE = 256;
// Draw at 4× and average down; cheaper than writing an anti-aliasing routine.
const SS = 4;

const NAVY = [0x00, 0x01, 0x30];
const LIME = [0xb7, 0xe0, 0x00];
const PINK = [0xe9, 0x35, 0x62];

/** Rounded-rectangle coverage test, in supersampled coordinates. */
function insideRoundedRect(x, y, left, top, width, height, radius) {
  const right = left + width;
  const bottom = top + height;
  if (x < left || x >= right || y < top || y >= bottom) return false;
  const cx = x < left + radius ? left + radius : x > right - radius ? right - radius : x;
  const cy = y < top + radius ? top + radius : y > bottom - radius ? bottom - radius : y;
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= radius * radius;
}

const W = SIZE * SS;
const hi = Buffer.alloc(W * W * 4);

function set(x, y, [r, g, b], a = 255) {
  const i = (y * W + x) * 4;
  hi[i] = r;
  hi[i + 1] = g;
  hi[i + 2] = b;
  hi[i + 3] = a;
}

// Background: a rounded square, the shape every platform expects of an app mark.
const pad = 0;
const radius = 56 * SS;
for (let y = 0; y < W; y++) {
  for (let x = 0; x < W; x++) {
    if (insideRoundedRect(x, y, pad, pad, W - 2 * pad, W - 2 * pad, radius)) set(x, y, NAVY);
  }
}

// Three filed documents, widest at the bottom — an archive, which is what this
// server exposes. Pink on top picks up the second LOUPZ accent.
const bars = [
  { width: 108, colour: PINK },
  { width: 136, colour: LIME },
  { width: 164, colour: LIME },
];
const barHeight = 26 * SS;
const gap = 18 * SS;
const totalHeight = bars.length * barHeight + (bars.length - 1) * gap;
let top = (W - totalHeight) / 2;
for (const { width, colour } of bars) {
  const w = width * SS;
  const left = (W - w) / 2;
  for (let y = top; y < top + barHeight; y++) {
    for (let x = left; x < left + w; x++) {
      if (insideRoundedRect(x, y, left, top, w, barHeight, barHeight / 2)) set(x, y, colour);
    }
  }
  top += barHeight + gap;
}

// Downsample.
const rgba = Buffer.alloc(SIZE * SIZE * 4);
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    let r = 0;
    let g = 0;
    let b = 0;
    let a = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const i = ((y * SS + sy) * W + (x * SS + sx)) * 4;
        // Premultiply so transparent pixels do not drag colour into the edges.
        const alpha = hi[i + 3];
        r += hi[i] * alpha;
        g += hi[i + 1] * alpha;
        b += hi[i + 2] * alpha;
        a += alpha;
      }
    }
    const o = (y * SIZE + x) * 4;
    rgba[o] = a === 0 ? 0 : Math.round(r / a);
    rgba[o + 1] = a === 0 ? 0 : Math.round(g / a);
    rgba[o + 2] = a === 0 ? 0 : Math.round(b / a);
    rgba[o + 3] = Math.round(a / (SS * SS));
  }
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([length, body, checksum]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // colour type: RGBA
ihdr[10] = 0; // deflate
ihdr[11] = 0; // adaptive filtering
ihdr[12] = 0; // no interlace

// Each scanline is prefixed with its filter byte; 0 means "none".
const stride = SIZE * 4;
const raw = Buffer.alloc((stride + 1) * SIZE);
for (let y = 0; y < SIZE; y++) {
  raw[y * (stride + 1)] = 0;
  rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, png);
console.log(`wrote ${OUT} — ${SIZE}x${SIZE}, ${png.length} bytes`);
