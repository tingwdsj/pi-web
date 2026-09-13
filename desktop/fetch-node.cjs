"use strict";

// Download a real Node 22 runtime into desktop/node-runtime/ for the desktop
// build. Cross-platform: win32/darwin/linux, x64/arm64.
//
// Why a real Node: the packaged app runs the Next.js standalone server with
// this binary instead of Electron's embedded Node (Electron 33 embeds Node
// 20.18, which is too old for Next 16.2.9's @edge-runtime — it calls
// webidl.util.markAsUncloneable, added in Node 22). See electron-builder.yml.
//
// The binary is ~40-80 MB, so it is NOT committed. This script fetches it on
// demand from the npmmirror CDN (China-friendly mirror of nodejs.org) and is a
// no-op when the runtime for the current platform/arch already exists.
//
// Platform / arch -> dist archive -> extracted executable:
//   win32  x64   node-v<ver>-win-x64.zip         -> node.exe
//   win32  arm64 node-v<ver>-win-arm64.zip       -> node.exe
//   darwin arm64 node-v<ver>-darwin-arm64.tar.gz -> bin/node
//   darwin x64   node-v<ver>-darwin-x64.tar.gz   -> bin/node
//   linux  x64   node-v<ver>-linux-x64.tar.gz    -> bin/node
//   linux  arm64 node-v<ver>-linux-arm64.tar.gz  -> bin/node
//
// Run manually:    node desktop/fetch-node.cjs
// Auto-run:        wired into `npm run desktop:build` (see package.json).

const fs = require("fs");
const os = require("os");
const path = require("path");
const https = require("https");
const zlib = require("zlib");
const { execFileSync } = require("child_process");

// Keep this in sync with the version noted in desktop-build.md. Node 22 LTS.
// The CDN path mirrors https://nodejs.org/dist/v<ver>/.
const NODE_VERSION = "22.14.0";
const MIRROR = process.env.NODE_MIRROR || "https://registry.npmmirror.com/-/binary/node";

const RUNTIME_DIR = path.join(__dirname, "node-runtime");

function log(msg) {
  console.log(`[fetch-node] ${msg}`);
}

// Map process.platform/arch to the nodejs.org dist naming scheme.
function resolveSpec() {
  const { platform, arch } = process;
  const osKey = platform === "win32" ? "win" : platform === "darwin" ? "darwin" : platform === "linux" ? "linux" : null;
  if (!osKey) throw new Error(`Unsupported platform: ${platform}`);
  const archKey = arch === "arm64" ? "arm64" : arch === "x64" ? "x64" : null;
  if (!archKey) throw new Error(`Unsupported architecture: ${arch} (only x64 and arm64 are published by nodejs.org)`);

  const isZip = osKey === "win";
  const ext = isZip ? "zip" : "tar.gz";
  const dirName = `node-v${NODE_VERSION}-${osKey}-${archKey}`;
  const exeName = isZip ? "node.exe" : "node";
  // Path of the executable inside the archive (forward slashes in both formats).
  const member = isZip ? `${dirName}/node.exe` : `${dirName}/bin/node`;
  return {
    osKey,
    archKey,
    dirName,
    exeName,
    member,
    isZip,
    url: `${MIRROR}/v${NODE_VERSION}/${dirName}.${ext}`,
  };
}

// Download a URL into a Buffer, following a single level of redirects
// (npmmirror may redirect to a CDN).
function fetchBuffer(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        fetchBuffer(res.headers.location).then(resolve, reject);
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

// Extract one member from a ZIP buffer without a zip dependency: parse the
// central directory, find the entry by name, and inflate its raw DEFLATE
// stream with zlib. (Windows runtime only.)
function extractFromZip(zip, memberName) {
  // End-of-Central-Directory record: search backwards for signature PK\x05\x06.
  let eocd = -1;
  for (let i = zip.length - 22; i >= 0; i--) {
    if (zip[i] === 0x50 && zip[i + 1] === 0x4b && zip[i + 2] === 0x05 && zip[i + 3] === 0x06) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("ZIP EOCD record not found — corrupt download?");

  const cdOffset = zip.readUInt32LE(eocd + 16);
  const cdEntries = zip.readUInt16LE(eocd + 10);

  let p = cdOffset;
  for (let i = 0; i < cdEntries; i++) {
    if (zip[p] !== 0x50 || zip[p + 1] !== 0x4b) throw new Error("Bad central directory entry");
    const compMethod = zip.readUInt16LE(p + 10);
    const compSize = zip.readUInt32LE(p + 20);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const localHeaderOffset = zip.readUInt32LE(p + 42);
    const name = zip.slice(p + 46, p + 46 + nameLen).toString("utf8");

    p += 46 + nameLen + extraLen + commentLen;

    if (name !== memberName) continue;

    // Read local file header to find the data offset.
    const lh = localHeaderOffset;
    if (zip[lh] !== 0x50 || zip[lh + 1] !== 0x4b) throw new Error("Bad local file header");
    const lhNameLen = zip.readUInt16LE(lh + 26);
    const lhExtraLen = zip.readUInt16LE(lh + 28);
    const dataStart = lh + 30 + lhNameLen + lhExtraLen;
    const compressed = zip.slice(dataStart, dataStart + compSize);

    if (compMethod === 0) return compressed; // stored
    if (compMethod !== 8) throw new Error(`Unsupported zip compression method ${compMethod}`);
    return zlib.inflateRawSync(compressed);
  }
  throw new Error(`${memberName} not found inside the downloaded archive`);
}

// Extract one member from a .tar.gz buffer. Rather than hand-roll a tar parser
// (gzip + tar framing — error-prone), write the archive to a temp file and let
// the system `tar` do it. macOS, Linux and Windows 10 1803+ all ship `tar`.
function extractFromTarGz(targz, memberName) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-node-"));
  const archive = path.join(tmpDir, "node.tar.gz");
  try {
    fs.writeFileSync(archive, targz);
    execFileSync("tar", ["-xzf", archive, "-C", tmpDir, memberName], { stdio: "inherit" });
    const extracted = path.join(tmpDir, ...memberName.split("/"));
    return fs.readFileSync(extracted);
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}

async function main() {
  const spec = resolveSpec();

  const outPath = path.join(RUNTIME_DIR, spec.exeName);
  if (fs.existsSync(outPath)) {
    log(`${spec.exeName} already present at ${outPath} — nothing to do`);
    return;
  }

  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  log(`Downloading Node v${NODE_VERSION} ${spec.osKey}-${spec.archKey} from ${spec.url}`);
  const archive = await fetchBuffer(spec.url);
  log(`Downloaded ${(archive.length / 1024 / 1024).toFixed(1)} MB, extracting ${spec.member}`);
  const exe = spec.isZip ? extractFromZip(archive, spec.member) : extractFromTarGz(archive, spec.member);
  fs.writeFileSync(outPath, exe);
  // tar normally preserves the exec bit, but set it explicitly for safety.
  if (process.platform !== "win32") fs.chmodSync(outPath, 0o755);
  log(`Wrote ${outPath} (${(exe.length / 1024 / 1024).toFixed(1)} MB)`);
}

main().catch((e) => {
  console.error(`[fetch-node] FAILED: ${e.message}`);
  let spec = { exeName: process.platform === "win32" ? "node.exe" : "node", url: "" };
  try {
    spec = resolveSpec();
  } catch {
    /* keep defaults */
  }
  console.error(`[fetch-node] You can also place the binary manually at ${path.join(RUNTIME_DIR, spec.exeName)}`);
  if (spec.url) console.error(`[fetch-node]   download from ${spec.url}`);
  process.exit(1);
});
