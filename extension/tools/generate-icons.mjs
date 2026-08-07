// Generates simple solid placeholder PNG icons for the extension.
// Run: node extension/tools/generate-icons.mjs
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "assets");
mkdirSync(outDir, { recursive: true });

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
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const body = Buffer.concat([typeBuf, data]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

// Solid RGBA fill with a slightly lighter inset square (crude "magic" mark).
function makePng(size, [r, g, b], [r2, g2, b2]) {
  const bytesPerPixel = 4;
  const stride = size * bytesPerPixel + 1; // +1 filter byte per row
  const raw = Buffer.alloc(stride * size);
  const inset = Math.floor(size * 0.28);
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0; // filter type 0
    for (let x = 0; x < size; x++) {
      const o = y * stride + 1 + x * bytesPerPixel;
      const inSquare = x >= inset && x < size - inset && y >= inset && y < size - inset;
      const [cr, cg, cb] = inSquare ? [r2, g2, b2] : [r, g, b];
      raw[o] = cr;
      raw[o + 1] = cg;
      raw[o + 2] = cb;
      raw[o + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  return png;
}

for (const size of [16, 32, 128]) {
  const png = makePng(size, [0x6c, 0x5c, 0xe7], [0xa2, 0x96, 0xff]);
  writeFileSync(join(outDir, `icon${size}.png`), png);
  console.log(`wrote icon${size}.png (${png.length} bytes)`);
}
