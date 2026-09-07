// Dependency-free PWA icon generator. The build box has no image tooling
// (magick/rsvg/inkscape absent), so we emit valid PNGs by hand: a dark
// terminal-palette background with a centered accent block echoing the
// wordmark cursor (▮). Run: `node scripts/gen-icons.mjs`. Deterministic —
// the committed PNGs are reproducible from this script.
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const OUT = fileURLToPath(new URL("../src/dashboard/public/icons/", import.meta.url));
mkdirSync(OUT, { recursive: true });

// Terminal palette (styles.css): bg #08090c, accent/live #0096ff, white.
const BG = [0x08, 0x09, 0x0c];
const ACCENT = [0x00, 0x96, 0xff];

const crcTable = (() => {
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
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

// A solid-bg icon with a centered accent block. `pad` is the block inset as a
// fraction of the side; `maskable` fills more of the frame so the safe zone
// survives platform masking.
function makePng(size, { maskable = false } = {}) {
  const inset = maskable ? 0.2 : 0.3;
  const blockLo = Math.round(size * inset);
  const blockHi = size - blockLo;
  // The cursor block is a tall centered bar (like ▮): narrower in x.
  const barLo = Math.round(size * (maskable ? 0.36 : 0.4));
  const barHi = size - barLo;

  const stride = size * 3 + 1; // filter byte + RGB row
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const inBlock = y >= blockLo && y < blockHi && x >= barLo && x < barHi;
      const [r, g, b] = inBlock ? ACCENT : BG;
      const o = y * stride + 1 + x * 3;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor RGB
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const targets = [
  ["icon-192.png", 192, {}],
  ["icon-512.png", 512, {}],
  ["icon-maskable-512.png", 512, { maskable: true }],
  ["apple-touch-icon-180.png", 180, {}],
];
for (const [name, size, opts] of targets) {
  writeFileSync(OUT + name, makePng(size, opts));
  console.log(`wrote ${name} (${size}x${size})`);
}
