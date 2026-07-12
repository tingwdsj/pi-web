"use strict";

// electron-builder beforeBuild hook.
//
// Returns false to signal that node_modules are handled externally — i.e. we do
// NOT want electron-builder to copy the project's production dependencies into
// resources/app/node_modules. The Electron main process (main.cjs) only requires
// `electron` (injected by the runtime, not from node_modules), Node builtins,
// and local ./lib/*.cjs helpers. The Next.js server + pi SDK run from a separate
// standalone bundle shipped via extraResources (resources/server/), which has its
// OWN node_modules tree. Copying the project deps into resources/app/ would add
// ~740 MB of dead weight (a duplicate of next, pi SDKs, aws-sdk, react, ...).
//
// Returning false sets areNodeModulesHandledExternally=true in packager.js,
// which skips computeNodeModuleFileSets entirely (platformPackager.js:301).
// The entry-file sanity check still passes — it only verifies main.cjs +
// package.json are present, not node_modules.
//
// Ref: https://www.electron.build/configuration#beforebuild
exports.default = async function skipDeps() {
  return false;
};
