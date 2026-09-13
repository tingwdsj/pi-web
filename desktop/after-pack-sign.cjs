"use strict";

// electron-builder afterPack hook: ad-hoc (re)sign the packed macOS .app.
//
// Why this exists
// ---------------
// We distribute the Mac build without an Apple Developer certificate
// (mac.identity: null in electron-builder.yml), so electron-builder never signs
// the bundle. macOS on Apple Silicon requires *every* arm64 executable to carry
// at least a valid ad-hoc signature. Upstream Electron ships ad-hoc-signed
// binaries, but repackaging (writing our resources) invalidates the outer
// bundle's signature. When a user downloads the resulting .dmg, macOS sets the
// quarantine attribute and refuses to launch the app — reporting it as
// "damaged and can't be opened" rather than the friendlier "unidentified
// developer". That "damaged" dialog cannot be dismissed with right-click >
// Open, so users would be stuck.
//
// Re-signing ad-hoc (`codesign --sign -`) inside the build restores a valid
// signature. Users still get the standard "unidentified developer" prompt (or
// `xattr -rd com.apple.quarantine`), which right-click > Open does dismiss.
//
// This runs after the .app is assembled but before the dmg is written. No-op on
// non-darwin platforms (electron-builder calls hooks for every target).
//
// Note: `--deep` is technically deprecated for signing, but for a plain
// unsigned Electron bundle it is the pragmatic way to sign the nested
// Frameworks/Helpers in one shot, and it is what most Electron projects use for
// ad-hoc distribution. If a proper Developer ID + notarization flow is added
// later, remove this hook and set mac.identity accordingly.

const { execFileSync } = require("child_process");
const path = require("path");

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;

  const appName = context.packager.appInfo.productFilename; // "Pi Agent"
  const appPath = path.join(context.appOutDir, `${appName}.app`);

  console.log(`[after-pack-sign] ad-hoc signing ${appPath}`);
  try {
    execFileSync(
      "codesign",
      ["--force", "--deep", "--sign", "-", "--timestamp=none", appPath],
      { stdio: "inherit" }
    );
    execFileSync("codesign", ["--verify", "--deep", "--verbose=2", appPath], { stdio: "inherit" });
    console.log("[after-pack-sign] ad-hoc signature applied and verified");
  } catch (e) {
    // Do not silently ship an unsigned arm64 app — fail the build instead.
    console.error(`[after-pack-sign] ad-hoc signing failed: ${e.message}`);
    throw e;
  }
};
