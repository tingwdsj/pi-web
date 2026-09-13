// Generates the desktop app icons:
//   - desktop/icon.ico   — multi-resolution Windows icon
//   - desktop/icon.icns  — multi-resolution macOS icon (on macOS only)
//
// Design: dark rounded square (#0a0a0a) with a centered π glyph in cyan
// (#22d3ee), matching the app's existing dark theme. Replace this file with a
// real logo later by dropping multi-resolution icon files in place.
//
// Uses sharp (already a transitive dependency) to rasterize an SVG to multiple
// PNG sizes. The .ico container is assembled by hand (ICOF format, no extra
// deps). The .icns container is produced by macOS's own `iconutil`, which
// requires an .iconset directory of correctly named PNGs — so this step only
// runs on macOS (Windows/Linux builds don't need .icns).
//
// Run with:  node desktop/make-icon.mjs   (== npm run desktop:icon)

import sharp from "sharp";
import { writeFile, mkdir, rm } from "fs/promises";
import { execFileSync } from "child_process";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_ICO = path.join(__dirname, "icon.ico");
const OUT_ICNS = path.join(__dirname, "icon.icns");
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

async function renderPng(size) {
  return sharp(Buffer.from(svg(size))).png().toBuffer();
}

function writeU16le(n) {
  return Buffer.from([n & 0xff, (n >> 8) & 0xff]);
}
function writeU32le(n) {
  return Buffer.from([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff]);
}

async function buildIco() {
  const pngs = [];
  for (const size of SIZES) {
    pngs.push({ size, data: await renderPng(size) });
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
    dirEntries.push(
      Buffer.concat([
        Buffer.from([w, h]), // width, height (0 => 256)
        Buffer.from([0]), // color palette
        Buffer.from([0]), // reserved
        writeU16le(1), // color planes
        writeU16le(32), // bits per pixel
        writeU32le(data.length), // image size
        writeU32le(dataOffset), // offset to image data
      ])
    );
    imageData.push(data);
    dataOffset += data.length;
  }

  const ico = Buffer.concat([header, ...dirEntries, ...imageData]);
  await writeFile(OUT_ICO, ico);
  console.log(`Wrote ${OUT_ICO} (${ico.length} bytes, ${pngs.length} sizes)`);
}

// macOS iconutil expects an .iconset directory containing these exact names.
// @2x variants are the same pixel dimensions as the next size up, rendered
// separately so each file is crisp at its target scale.
const ICNSET_ENTRIES = [
  ["icon_16x16.png", 16],
  ["icon_16x16@2x.png", 32],
  ["icon_32x32.png", 32],
  ["icon_32x32@2x.png", 64],
  ["icon_128x128.png", 128],
  ["icon_128x128@2x.png", 256],
  ["icon_256x256.png", 256],
  ["icon_256x256@2x.png", 512],
  ["icon_512x512.png", 512],
  ["icon_512x512@2x.png", 1024],
];

async function buildIcns() {
  if (process.platform !== "darwin") {
    console.log("Skipping icon.icns (iconutil is macOS-only)");
    return;
  }
  const workDir = path.join(os.tmpdir(), `pi-iconset-${process.pid}`);
  const iconsetDir = path.join(workDir, "icon.iconset");
  try {
    await mkdir(iconsetDir, { recursive: true });
    const cache = new Map();
    for (const [name, size] of ICNSET_ENTRIES) {
      if (!cache.has(size)) cache.set(size, await renderPng(size));
      await writeFile(path.join(iconsetDir, name), cache.get(size));
    }
    execFileSync("iconutil", ["-c", "icns", iconsetDir, "-o", OUT_ICNS], { stdio: "inherit" });
    console.log(`Wrote ${OUT_ICNS}`);
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function main() {
  await buildIco();
  await buildIcns();
}

main().catch((e) => {
  console.error("Icon generation failed:", e);
  process.exit(1);
});
