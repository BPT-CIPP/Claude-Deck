'use strict';
// Draws the Claude Deck mark (the pixel-art Claude Code mascot on a transparent background) and
// writes the app icons:
//   public/icons/icon-192.png, icon-512.png, icon-maskable-512.png, claude-deck.ico
// Pure Node (zlib for PNG compression), so no image tools are needed. The same grid is drawn as
// an SVG in public/index.html (.brand-mark); keep the two in step.
//
//   node tools/make-icons.js

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.join(__dirname, '..', 'public', 'icons');

// 14 x 10 pixel grid: B = body, E = eye, . = transparent.
const MASCOT = [
  '..BBBBBBBBBB..',
  '..BBBBBBBBBB..',
  '..BBEBBBBEBB..',
  '..BBEBBBBEBB..',
  'BBBBBBBBBBBBBB',
  'BBBBBBBBBBBBBB',
  '..BBBBBBBBBB..',
  '..BBBBBBBBBB..',
  '..B.B....B.B..',
  '..B.B....B.B..',
];
const COLORS = { B: [0xd9, 0x77, 0x57], E: [0x14, 0x14, 0x13] };
// Only the maskable icon has a background: the OS crops it to its own shape.
const MASK_BG = [0x14, 0x14, 0x13];
const COLS = MASCOT[0].length;
const ROWS = MASCOT.length;

// Color of the mark at a point in unit space. `pad` is the margin around the mascot.
function sample(u, v, { pad, bg }) {
  const cell = (1 - pad * 2) / COLS;
  const top = (1 - cell * ROWS) / 2; // centered vertically
  const col = Math.floor((u - pad) / cell);
  const row = Math.floor((v - top) / cell);
  const ch = row >= 0 && row < ROWS && col >= 0 && col < COLS ? MASCOT[row][col] : '.';
  if (ch !== '.') return { color: COLORS[ch], alpha: 1 };
  return bg ? { color: bg, alpha: 1 } : { color: null, alpha: 0 };
}

// Render with 4x4 supersampling for smooth edges. Returns RGBA bytes.
function render(size, opts) {
  const px = Buffer.alloc(size * size * 4);
  const N = 4;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0; let g = 0; let b = 0; let a = 0;
      for (let sy = 0; sy < N; sy++) {
        for (let sx = 0; sx < N; sx++) {
          const s = sample((x + (sx + 0.5) / N) / size, (y + (sy + 0.5) / N) / size, opts);
          if (s.alpha) { r += s.color[0]; g += s.color[1]; b += s.color[2]; a += 1; }
        }
      }
      const i = (y * size + x) * 4;
      if (a) {
        px[i] = Math.round(r / a);
        px[i + 1] = Math.round(g / a);
        px[i + 2] = Math.round(b / a);
      }
      px[i + 3] = Math.round((a / (N * N)) * 255);
    }
  }
  return px;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ICO with PNG-compressed entries (supported since Windows Vista).
function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const dir = Buffer.alloc(16 * images.length);
  let offset = 6 + dir.length;
  images.forEach(({ size, data }, i) => {
    const o = i * 16;
    dir[o] = size >= 256 ? 0 : size;
    dir[o + 1] = size >= 256 ? 0 : size;
    dir.writeUInt16LE(1, o + 4); // planes
    dir.writeUInt16LE(32, o + 6); // bits per pixel
    dir.writeUInt32LE(data.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += data.length;
  });
  return Buffer.concat([header, dir, ...images.map((im) => im.data)]);
}

function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const plain = { pad: 0.02, bg: null };
  for (const size of [192, 512]) fs.writeFileSync(path.join(OUT, `icon-${size}.png`), png(size, render(size, plain)));
  // Maskable: full-bleed background, mark kept inside the central safe zone.
  fs.writeFileSync(path.join(OUT, 'icon-maskable-512.png'), png(512, render(512, { pad: 0.2, bg: MASK_BG })));
  const icoImages = [16, 24, 32, 48, 64, 256].map((size) => ({ size, data: png(size, render(size, plain)) }));
  fs.writeFileSync(path.join(OUT, 'claude-deck.ico'), ico(icoImages));
  for (const f of fs.readdirSync(OUT)) console.log(`${f}  ${fs.statSync(path.join(OUT, f)).size} bytes`);
}

main();
