import type { NextConfig } from "next";
import { readFileSync } from "fs";
import { join } from "path";

const { version } = JSON.parse(readFileSync(join(__dirname, "package.json"), "utf8")) as { version: string };
let piVersion = "unknown";
try {
  const piPkgPath = join(__dirname, "node_modules/@earendil-works/pi-coding-agent/package.json");
  piVersion = (JSON.parse(readFileSync(piPkgPath, "utf8")) as { version: string }).version;
} catch { /* package not found, use default */ }

// @vercel/nft stray-EPERM guards are Windows-only. On POSIX we must NOT exclude
// the home tree: Next matches these globs with `contains` against ABSOLUTE
// paths, and the project is built under the user's home on macOS/Linux — so a
// pattern like "/Users/**" silently excludes every traced file (the standalone
// bundle then ships without its node_modules). See docs/desktop-build-mac.zh-CN.md.
const nftExcludes =
  process.platform === "win32"
    ? ["C:\\Users\\**", "C:\\Program Files\\**", "C:\\Program Files (x86)\\**"]
    : [];

const nextConfig: NextConfig = {
  // Desktop packaging: produce a self-contained server in .next/standalone so
  // the Electron app can run it with plain `node server.js` (no `next` CLI at
  // runtime). Additive — does not affect the existing npm-CLI publish path.
  // The pi SDK packages are serverExternalPackages, so Next traces them into
  // standalone automatically as real node_modules. Standalone's chunk copy can
  // miss a webpack chunk that a route's .nft.json lists (e.g. mammoth's zip
  // code split into chunk 3379); desktop/ensure-standalone-chunks.cjs runs
  // post-build to backfill any missing chunks.
  output: "standalone",
  serverExternalPackages: ["@earendil-works/pi-coding-agent", "@earendil-works/pi-ai"],
  // On some Windows machines the @vercel/nft file tracer follows a stray
  // dependency edge into protected/irrelevant dirs under the user profile
  // (e.g. AppData\Local\Intel\...) and aborts the build. Those paths are never
  // real runtime dependencies — exclude the whole user-profile tree from
  // tracing. Program Files is excluded for the same reason: nft has been seen
  // following edges into WindowsApps (Bandisoft, PowerAutomate) which makes
  // "Failed to copy traced files" drop the affected route's entire traced set
  // (silently losing xlsx/adm-zip/mammoth). desktop/ensure-standalone-chunks.cjs
  // backfills those regardless, but excluding here keeps the build clean.
  // (See desktop/win-eperm-patch.cjs for the matching fs guard.)
  outputFileTracingExcludes: {
    "*": nftExcludes,
  },
  allowedDevOrigins: ['192.168.*.*'],
  async headers() {
    return [
      {
        source: "/",
        headers: [
          { key: "Cache-Control", value: "private, no-cache, max-age=0, must-revalidate" },
        ],
      },
    ];
  },
  env: {
    NEXT_PUBLIC_APP_VERSION: version,
    NEXT_PUBLIC_PI_VERSION: piVersion,
  },
};

export default nextConfig;
