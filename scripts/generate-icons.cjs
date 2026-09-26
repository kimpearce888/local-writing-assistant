/**
 * Generate the extension's icons (16/32/48/128) as simple PNGs.
 *
 * We don't depend on any external graphics library — we hand-roll a
 * minimal PNG encoder using only Node's built-in zlib. The icon design
 * is a stylized "LWA" mark on a colored rounded square.
 *
 * Run via: node scripts/generate-icons.js
 */

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

function makeIcon(size) {
  // RGBA pixel buffer.
  const pixels = Buffer.alloc(size * size * 4);
  const r = size / 2;
  const cx = size / 2;
  const cy = size / 2;
  // Background gradient colors.
  const bgTop = [31, 111, 235, 255]; // #1f6feb
  const bgBot = [18, 80, 200, 255];
  // Letter color.
  const letter = [255, 255, 255, 255];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      // Rounded square mask: max(|dx|,|dy|) <= 0.85*size/2
      const inSquare = Math.max(Math.abs(dx), Math.abs(dy)) <= (size * 0.45);
      if (!inSquare) {
        pixels[i] = 0;
        pixels[i + 1] = 0;
        pixels[i + 2] = 0;
        pixels[i + 3] = 0; // transparent
        continue;
      }
      // Vertical gradient.
      const t = y / size;
      const bg = [
        Math.round(bgTop[0] + (bgBot[0] - bgTop[0]) * t),
        Math.round(bgTop[1] + (bgBot[1] - bgTop[1]) * t),
        Math.round(bgTop[2] + (bgBot[2] - bgTop[2]) * t),
        255,
      ];
      // Draw a simple "L" shape (vertical bar + small horizontal foot).
      const inLetter = isLetterPixel(x, y, size);
      const color = inLetter ? letter : bg;
      pixels[i] = color[0];
      pixels[i + 1] = color[1];
      pixels[i + 2] = color[2];
      pixels[i + 3] = color[3];
      // Anti-alias the rounded square edge.
      if (Math.max(Math.abs(dx), Math.abs(dy)) > size * 0.43) {
        pixels[i + 3] = Math.round(255 * 0.6);
      }
    }
  }
  return pixels;
}

function isLetterPixel(x, y, size) {
  // Simple "L" mark: a vertical bar on the left, plus a horizontal foot.
  const barX0 = size * 0.35;
  const barX1 = size * 0.50;
  const barY0 = size * 0.25;
  const barY1 = size * 0.75;
  const footY0 = size * 0.65;
  const footY1 = size * 0.75;
  const footX0 = size * 0.35;
  const footX1 = size * 0.70;
  const inBar = x >= barX0 && x <= barX1 && y >= barY0 && y <= barY1;
  const inFoot = y >= footY0 && y <= footY1 && x >= footX0 && x <= footX1;
  return inBar || inFoot;
}

function encodePNG(pixels, width, height) {
  // Build the raw image data with filter byte (0 = none) per scanline.
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const compressed = zlib.deflateSync(raw);

  function crc32(buf) {
    let table = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      table[n] = c >>> 0;
    }
    let crc = 0xffffffff;
    for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }

  function u32(n) {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(n >>> 0, 0);
    return b;
  }

  function chunk(type, data) {
    const len = u32(data.length);
    const typeBuf = Buffer.from(type, "ascii");
    const crc = u32(crc32(Buffer.concat([typeBuf, data])));
    return Buffer.concat([len, typeBuf, data, crc]);
  }

  // PNG signature.
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  // IHDR
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type (RGBA)
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  const ihdrChunk = chunk("IHDR", ihdr);
  const idatChunk = chunk("IDAT", compressed);
  const iendChunk = chunk("IEND", Buffer.alloc(0));
  return Buffer.concat([sig, ihdrChunk, idatChunk, iendChunk]);
}

function main() {
  const outDir = path.resolve(__dirname, "..", "extension", "public", "icons");
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  for (const size of [16, 32, 48, 128]) {
    const px = makeIcon(size);
    const png = encodePNG(px, size, size);
    const out = path.join(outDir, `icon-${size}.png`);
    fs.writeFileSync(out, png);
    console.log(`wrote ${out} (${png.length} bytes)`);
  }
}

main();
