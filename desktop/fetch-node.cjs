"use strict";

// Download the Node 22 win-x64 runtime into desktop/node-runtime/node.exe.
//
// The desktop build runs the Next standalone server with a real Node (not
// Electron's embedded Node 20, which is too old for Next 16.2.9's
// edge-runtime — markAsUncloneable is missing). Rather than ship an 80MB
// binary in git, this script fetches it on demand from the npmmirror CDN
// (China-friendly mirror of nodejs.org). It's a no-op if node.exe is already
// present, so it's safe to run before every build.
//
// Run manually:    node desktop/fetch-node.cjs
// Auto-run:        wired into `npm run desktop:build` (see package.json).

const fs = require("fs");
const path = require("path");
const https = require("https");

// Keep this in sync with the version noted in desktop-build.md. Node 22 LTS,
// win-x64. The CDN path mirrors https://nodejs.org/dist/v<ver>/.
const NODE_VERSION = "22.14.0";
const MIRROR = process.env.NODE_MIRROR || "https://registry.npmmirror.com/-/binary/node";
const DOWNLOAD_URL = `${MIRROR}/v${NODE_VERSION}/node-v${NODE_VERSION}-win-x64.zip`;

const RUNTIME_DIR = path.join(__dirname, "node-runtime");
const NODE_EXE = path.join(RUNTIME_DIR, "node.exe");

function log(msg) {
  console.log(`[fetch-node] ${msg}`);
}

function fetchZip(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      // Follow a single redirect (npmmirror may redirect).
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        fetchZip(res.headers.location).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
        return;
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    }).on("error", reject);
  });
}

// Extract node.exe from the zip without a dependency on a zip library: parse
// the ZIP central directory, find the entry whose name ends with
// `node.exe` (top-level inside the archive), and inflate its raw DEFLATE
// stream with zlib. Avoids adding unzip/adm-zip as a build dependency.
function extractNodeExe(zipBuffer) {
  const zlib = require("zlib");

  // End-of-Central-Directory record: search backwards for signature PK\x05\x06.
  let eocd = -1;
  for (let i = zipBuffer.length - 22; i >= 0; i--) {
    if (zipBuffer[i] === 0x50 && zipBuffer[i + 1] === 0x4b && zipBuffer[i + 2] === 0x05 && zipBuffer[i + 3] === 0x06) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("ZIP EOCD record not found — corrupt download?");

  const cdOffset = zipBuffer.readUInt32LE(eocd + 16);
  const cdEntries = zipBuffer.readUInt16LE(eocd + 10);

  let p = cdOffset;
  for (let i = 0; i < cdEntries; i++) {
    // Central directory file header signature PK\x01\x02
    if (zipBuffer[p] !== 0x50 || zipBuffer[p + 1] !== 0x4b) throw new Error("Bad central directory entry");
    const compMethod = zipBuffer.readUInt16LE(p + 10);
    const compSize = zipBuffer.readUInt32LE(p + 20);
    const nameLen = zipBuffer.readUInt16LE(p + 28);
    const extraLen = zipBuffer.readUInt16LE(p + 30);
    const commentLen = zipBuffer.readUInt16LE(p + 32);
    const localHeaderOffset = zipBuffer.readUInt32LE(p + 42);
    const name = zipBuffer.slice(p + 46, p + 46 + nameLen).toString("utf8");

    p += 46 + nameLen + extraLen + commentLen;

    // Top-level node.exe inside node-v<ver>-win-x64/ — name ends with /node.exe.
    if (!name.endsWith("/node.exe")) continue;

    // Read local file header to find the data offset.
    const lh = localHeaderOffset;
    if (zipBuffer[lh] !== 0x50 || zipBuffer[lh + 1] !== 0x4b) throw new Error("Bad local file header");
    const lhNameLen = zipBuffer.readUInt16LE(lh + 26);
    const lhExtraLen = zipBuffer.readUInt16LE(lh + 28);
    const dataStart = lh + 30 + lhNameLen + lhExtraLen;
    const compressed = zipBuffer.slice(dataStart, dataStart + compSize);

    if (compMethod === 0) {
      return compressed; // stored, no compression
    }
    if (compMethod !== 8) throw new Error(`Unsupported zip compression method ${compMethod}`);
    return zlib.inflateRawSync(compressed);
  }
  throw new Error("node.exe not found inside the downloaded archive");
}

async function main() {
  if (fs.existsSync(NODE_EXE)) {
    log(`node.exe already present at ${NODE_EXE} — nothing to do`);
    return;
  }

  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  log(`Downloading Node v${NODE_VERSION} win-x64 from ${DOWNLOAD_URL}`);
  const zip = await fetchZip(DOWNLOAD_URL);
  log(`Downloaded ${(zip.length / 1024 / 1024).toFixed(1)} MB, extracting node.exe`);
  const nodeExe = extractNodeExe(zip);
  fs.writeFileSync(NODE_EXE, nodeExe);
  log(`Wrote ${NODE_EXE} (${(nodeExe.length / 1024 / 1024).toFixed(1)} MB)`);
}

main().catch((e) => {
  console.error(`[fetch-node] FAILED: ${e.message}`);
  console.error(`[fetch-node] You can also place node.exe manually at ${NODE_EXE}`);
  console.error(`[fetch-node]   download from https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-win-x64.zip`);
  process.exit(1);
});
