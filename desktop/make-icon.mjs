// Generates desktop/icon.ico — a placeholder app icon for Pi Agent.
//
// Design: dark rounded square (#0a0a0a) with a centered π glyph in cyan
// (#22d3ee), matching the app's existing dark theme. Replace this file with a
// real logo later by dropping a multi-resolution icon.ico in place.
//
// Uses sharp (already a transitive dependency) to rasterize an SVG to multiple
// PNG sizes, then assembles them into a Windows .ico (ICOF format) by hand —
// no extra deps needed.
//
// Run with:  node desktop/make-icon.mjs

import sharp from "sharp";
import { writeFile } from "fs/promises";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_ICO = path.join(__dirname, "icon.ico");
const SIZES = [16, 24, 32, 48, 64, 128, 256];

// 256 viewBox so the glyph scales crisply at every size.
const svg = (size) => `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 256 256">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#111114"/>
      <stop offset="1" stop-color="#060608"/>
    </linearGradient>
  </defs>
  <rect x="8" y="8" width="240" height="240" rx="52" ry="52" fill="url(#bg)" stroke="#1f2937" stroke-width="2"/>
  <text x="128" y="128" font-family="Georgia, 'Times New Roman', serif"
        font-size="168" font-weight="700" fill="#22d3ee"
        text-anchor="middle" dominant-baseline="central">&#960;</text>
</svg>`;

function writeU16le(n) {
  return Buffer.from([n & 0xff, (n >> 8) & 0xff]);
}
function writeU32le(n) {
  return Buffer.from([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff]);
}

async function main() {
  const pngs = [];
  for (const size of SIZES) {
    const png = await sharp(Buffer.from(svg(size))).png().toBuffer();
    pngs.push({ size, data: png });
  }

  // ICO header: reserved(2)=0, type(2)=1, count(2)=N
  const header = Buffer.concat([writeU16le(0), writeU16le(1), writeU16le(pngs.length)]);

  // Each directory entry is 16 bytes. Image data follows.
  const dirEntries = [];
  const imageData = [];
  let dataOffset = 6 + pngs.length * 16;
  for (const { size, data } of pngs) {
    const w = size >= 256 ? 0 : size; // 256 is encoded as 0 in ICO
    const h = w;
    dirEntries.push(Buffer.concat([
      Buffer.from([w, h]),          // width, height (0 => 256)
      Buffer.from([0]),             // color palette
      Buffer.from([0]),             // reserved
      writeU16le(1),                // color planes
      writeU16le(32),               // bits per pixel
      writeU32le(data.length),      // image size
      writeU32le(dataOffset),       // offset to image data
    ]));
    imageData.push(data);
    dataOffset += data.length;
  }

  const ico = Buffer.concat([header, ...dirEntries, ...imageData]);
  await writeFile(OUT_ICO, ico);
  console.log(`Wrote ${OUT_ICO} (${ico.length} bytes, ${pngs.length} sizes)`);
}

main().catch((e) => {
  console.error("Icon generation failed:", e);
  process.exit(1);
});
