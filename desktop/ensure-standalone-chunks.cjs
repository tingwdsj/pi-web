"use strict";

// Post-`next build` fixup for the desktop standalone server.
//
// Problem: Next's standalone output mode occasionally fails to copy a webpack
// chunk that a route's .nft.json lists as a dependency — seen in the wild as
// `Cannot find module './chunks/3379.js'` when rendering _not-found, which
// breaks the docx preview endpoint (mammoth's zip/DEFLATE code was split into
// chunk 3379, traced by .nft.json but not copied into .next/standalone).
//
// Fix: after `next build`, copy every chunk from the dev build's
// `.next/server/chunks/` into the standalone tree's `.next/server/chunks/`,
// filling in whatever the tracer missed. Idempotent — only copies files that
// are missing or differ.
//
// Run between `next build` and `electron-builder` (see package.json
// `desktop:build`). No-op if standalone doesn't exist yet.

const fs = require("fs");
const path = require("path");

const projectRoot = path.resolve(__dirname, "..");
const devChunksDir = path.join(projectRoot, ".next", "server", "chunks");
const standaloneDir = path.join(projectRoot, ".next", "standalone");
const standaloneServerDir = path.join(standaloneDir, ".next", "server");
const standaloneChunksDir = path.join(standaloneServerDir, "chunks");

function log(msg) {
  console.log(`[ensure-standalone-chunks] ${msg}`);
}

function copyMissing(srcDir, dstDir, label) {
  if (!fs.existsSync(srcDir)) {
    log(`source missing: ${srcDir} (nothing to do for ${label})`);
    return 0;
  }
  let copied = 0;
  const entries = fs.readdirSync(srcDir);
  for (const name of entries) {
    const src = path.join(srcDir, name);
    const dst = path.join(dstDir, name);
    if (!fs.statSync(src).isFile()) continue;
    let needCopy = true;
    if (fs.existsSync(dst)) {
      try {
        if (fs.statSync(dst).size === fs.statSync(src).size) needCopy = false;
      } catch {
        needCopy = true;
      }
    }
    if (needCopy) {
      fs.mkdirSync(dstDir, { recursive: true });
      fs.copyFileSync(src, dst);
      copied++;
    }
  }
  return copied;
}

// Recursively sync a directory tree (files + subdirs) from src to dst, only
// copying files that are missing or differ in size. Used for runtime-loaded
// resource dirs that @vercel/nft cannot trace (see syncPiExportResources).
function copyTreeMissing(srcDir, dstDir, label) {
  if (!fs.existsSync(srcDir)) {
    log(`source missing: ${srcDir} (nothing to do for ${label})`);
    return 0;
  }
  let copied = 0;
  const walk = (s, d) => {
    fs.mkdirSync(d, { recursive: true });
    for (const name of fs.readdirSync(s)) {
      const src = path.join(s, name);
      const dst = path.join(d, name);
      const st = fs.statSync(src);
      if (st.isDirectory()) {
        walk(src, dst);
      } else {
        let needCopy = true;
        if (fs.existsSync(dst)) {
          try {
            if (fs.statSync(dst).size === st.size) needCopy = false;
          } catch {
            needCopy = true;
          }
        }
        if (needCopy) {
          fs.copyFileSync(src, dst);
          copied++;
        }
      }
    }
  };
  walk(srcDir, dstDir);
  return copied;
}

// pi-coding-agent's session-export path (app/api/sessions/[id]/export) relies
// on runtime resources that @vercel/nft does NOT trace:
//
//   - dist/cli.js              : the `pi` CLI entry (package.json "bin"). nft
//                                only sees require/import; the route spawns it
//                                via execFile(node, [cliPath, "--export", ...])
//                                — a runtime-built path string, invisible to
//                                static tracing. Without it, getPiCliPath()
//                                returns null and the route falls back to
//                                `import(pathToFileURL(...))`, which fails on
//                                Windows paths containing non-ASCII (the
//                                percent-encoding in the file:// URL breaks
//                                Node's dynamic import resolution).
//
//   - Non-JS resource files under dist/ (templates, themes, assets, vendor
//     bundles): read at runtime via readFileSync() — e.g. export-html/index.js
//     reads template.html/template.css/template.js/vendor/*.js, and the theme
//     loader reads modes/interactive/theme/*.json. Because they are not
//                                require/imported, nft skips them, and the CLI
//                                throws `ENOENT ... template.html` / `dark.json`
//                                at export time.
//
// Fix: copy dist/cli.js and every non-source-map file under dist/core/export-html/
// and dist/modes/ (the dirs holding runtime-loaded resources) from the source
// node_modules into the standalone tree. We sync whole subtrees rather than
// enumerating individual files, so future resources added upstream are covered
// automatically.
function syncPiExportResources() {
  const piPkgDir = path.join(projectRoot, "node_modules", "@earendil-works", "pi-coding-agent");
  const standalonePiPkgDir = path.join(
    standaloneDir, "node_modules", "@earendil-works", "pi-coding-agent"
  );
  if (!fs.existsSync(standalonePiPkgDir)) {
    log(`standalone pi-coding-agent not found — skipping export-resource sync`);
    return;
  }

  // dist/cli.js (single file, not the dist/cli/ directory).
  let cliCopied = 0;
  const srcCli = path.join(piPkgDir, "dist", "cli.js");
  const dstCli = path.join(standalonePiPkgDir, "dist", "cli.js");
  if (fs.existsSync(srcCli) && !fs.existsSync(dstCli)) {
    fs.copyFileSync(srcCli, dstCli);
    cliCopied = 1;
  }
  log(`pi dist/cli.js: ${cliCopied ? "copied (was missing)" : "present"}`);

  // Runtime resource subtrees. copyTreeMissing is idempotent and only copies
  // missing/differing files, so re-running after a partial sync is safe.
  //   - dist/core/export-html : templates + vendored marked/highlight
  //   - dist/modes            : interactive theme JSON + assets
  const subtrees = [
    ["dist", "core", "export-html"],
    ["dist", "modes"],
  ];
  for (const segs of subtrees) {
    const src = path.join(piPkgDir, ...segs);
    const dst = path.join(standalonePiPkgDir, ...segs);
    const copied = copyTreeMissing(src, dst, segs.join("/"));
    log(`pi ${segs.join("/")}/: ${copied} file(s) synced`);
  }

  // Verify the specific runtime-loaded files known to be read during export.
  const required = [
    ["dist", "core", "export-html", "template.html"],
    ["dist", "core", "export-html", "template.css"],
    ["dist", "core", "export-html", "template.js"],
    ["dist", "core", "export-html", "vendor", "marked.min.js"],
    ["dist", "core", "export-html", "vendor", "highlight.min.js"],
    ["dist", "modes", "interactive", "theme", "dark.json"],
    ["dist", "modes", "interactive", "theme", "light.json"],
  ];
  const stillMissing = required.filter(
    (segs) => !fs.existsSync(path.join(standalonePiPkgDir, ...segs))
  );
  log(`export resources: missing after sync: ${stillMissing.length || "none"}`);
  if (stillMissing.length) {
    log(`WARNING: still missing: ${stillMissing.map((s) => s.join("/")).join(", ")}`);
    process.exitCode = 1;
  }
}

function main() {
  if (!fs.existsSync(standaloneDir)) {
    log(`standalone dir not found at ${standaloneDir} — skipping (run after next build)`);
    return;
  }

  // 1. Sync all webpack chunks from the dev build into standalone.
  const devCount = fs.existsSync(devChunksDir)
    ? fs.readdirSync(devChunksDir).filter((n) => n.endsWith(".js")).length
    : 0;
  const beforeCount = fs.existsSync(standaloneChunksDir)
    ? fs.readdirSync(standaloneChunksDir).filter((n) => n.endsWith(".js")).length
    : 0;

  const copied = copyMissing(devChunksDir, standaloneChunksDir, "chunks");

  const afterCount = fs.existsSync(standaloneChunksDir)
    ? fs.readdirSync(standaloneChunksDir).filter((n) => n.endsWith(".js")).length
    : 0;
  log(`chunks: dev=${devCount}, standalone before=${beforeCount}, copied=${copied}, after=${afterCount}`);

  // 2. Verify: scan every .js under standalone .next/server for `./chunks/<id>.js`
  //    requires and assert each referenced chunk exists. Report any still-missing.
  const missing = new Set();
  function scanDir(dir) {
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const st = fs.statSync(full);
      if (st.isDirectory()) {
        scanDir(full);
      } else if (name.endsWith(".js")) {
        const text = fs.readFileSync(full, "utf8");
        const re = /["'`]\.\/chunks\/(\d+\.js)["'`]/g;
        let m;
        while ((m = re.exec(text)) !== null) {
          const chunkPath = path.join(standaloneChunksDir, m[1]);
          if (!fs.existsSync(chunkPath)) missing.add(m[1]);
        }
      }
    }
  }
  scanDir(standaloneServerDir);
  if (missing.size) {
    log(`WARNING: ${missing.size} chunk(s) still referenced but not present: ${[...missing].join(", ")}`);
    log(`These are not in the dev build either; the route that needs them may fail at runtime.`);
    process.exitCode = 1;
  } else {
    log(`verification: all referenced chunks present in standalone`);
  }

  // 3. Backfill pi-coding-agent export resources that nft cannot trace
  //    (CLI entry + export-html templates/vendor). See syncPiExportResources.
  syncPiExportResources();

  // 4. Ensure third-party npm deps used by API routes are in standalone.
  //    On some machines @vercel/nft follows stray edges into system dirs
  //    (Program Files\WindowsApps, .Neo4jDesktop, ...) and the resulting
  //    "Failed to copy traced files" aborts copying that route's ENTIRE traced
  //    set — which silently drops xlsx/adm-zip/mammoth even though they're
  //    declared in dependencies. Backfill them from the source node_modules
  //    (whole-package copy, like syncPiExportResources does for the SDK), then
  //    assert presence so a residual miss fails the build rather than the user.
  syncThirdPartyDeps();
}

// Backfill runtime third-party deps into the standalone tree, then assert.
function syncThirdPartyDeps() {
  const deps = ["xlsx", "adm-zip", "mammoth"];
  const srcModules = path.join(projectRoot, "node_modules");
  const dstModules = path.join(standaloneDir, "node_modules");
  let synced = [];
  for (const dep of deps) {
    const dst = path.join(dstModules, dep);
    if (fs.existsSync(dst)) continue; // nft already got it
    const src = path.join(srcModules, dep);
    if (!fs.existsSync(src)) {
      log(`third-party ${dep}: source missing in node_modules — skipping`);
      continue;
    }
    const n = copyTreeMissing(src, dst, `node_modules/${dep}`);
    synced.push(`${dep} (${n})`);
  }
  if (synced.length) log(`third-party deps backfilled: ${synced.join(", ")}`);

  // Final assertion: every dep must now be present.
  const missing = deps.filter((d) => !fs.existsSync(path.join(dstModules, d)));
  if (missing.length) {
    log(`WARNING: third-party dep(s) STILL missing from standalone: ${missing.join(", ")}`);
    log(`The desktop app will error at runtime (Cannot find module).`);
    process.exitCode = 1;
  } else {
    log(`third-party deps present in standalone: ${deps.join(", ")}`);
  }
}

main();
