# Desktop Build Notes (Windows)

This document is for anyone **building the Pi Agent Windows desktop app from source**. It covers the build flow, file responsibilities, and the real pitfalls hit during packaging and distribution. For everyday usage see the [main README](../README.md) "Desktop app (Windows)" section.

> The code lives under `desktop/`; the build config is `desktop/electron-builder.yml`.

---

## 1. Architecture

Pi Agent desktop = **Electron shell + bundled Next.js standalone server + bundled Node 22 runtime**.

```
Pi Agent.exe (Electron main process, main.cjs)
  ├─ First run: seed ~/.pi/agent/{models.json, settings.json} (skipped if present)
  ├─ Pick a free loopback port
  ├─ spawn resources/node/node.exe to run resources/server/server.js (Next standalone)
  ├─ Poll /api/home until 200
  └─ BrowserWindow loads http://127.0.0.1:<port>/
```

Key decision: **the Next server is NOT run with Electron's embedded Node** — a separate Node 22 is shipped. Reason: see Pitfall 4 below.

Installed layout (`%LOCALAPPDATA%\Programs\Pi Agent`):

```
Pi Agent.exe
resources/
  app/                 <- Electron app package (asar disabled)
    main.cjs           <- main process entry
    preload.cjs
    lib/               <- port.cjs / seed.cjs / spawn.cjs
    seed-models.json   <- DeepSeek template for first-run seed
    seed-settings.json
    icon.ico
    package.json       <- main: main.cjs
  server/              <- Next.js standalone (with its own node_modules)
    server.js
    .next/static/
    node_modules/@earendil-works/...   <- pi SDK + LLM SDKs
  node/
    node.exe           <- Node 22 runtime (~80 MB)
```

---

## 2. Build Steps

### Prerequisites

- Windows 10/11, Node 18+ (to run `next build` and `electron-builder`; unrelated to the runtime)
- `npm install` done (so `electron`, `electron-builder`, `cross-env` etc. are present)

### One-shot build

```bash
npm run desktop:build
```

Equivalent to:

```bash
# 1. (first run) Download the Node 22 runtime to desktop/node-runtime/node.exe (skipped if present)
node desktop/fetch-node.cjs

# 2. Next production build (standalone output + file tracing)
cross-env NODE_OPTIONS="--require ./desktop/win-eperm-patch.cjs" next build --webpack

# 3. Backfill runtime resources nft failed to trace (pi CLI / export templates / themes)
node desktop/ensure-standalone-chunks.cjs

# 4. electron-builder produces the NSIS installer
electron-builder --config desktop/electron-builder.yml
```

Output: `dist-electron/Pi Agent Setup <version>.exe` (~175 MB).

### Icon (optional)

```bash
npm run desktop:icon     # renders SVG to multi-size icon.ico via sharp
```

The icon is committed (`desktop/icon.ico`); you only need this if you change the design in `desktop/make-icon.mjs`.

### Dev mode (hot reload)

```bash
npm run desktop:dev      # cross-env PI_DESKTOP_DEV=1 electron desktop/main.cjs
```

In dev, `main.cjs` spawns `next dev` (fixed port 30141) instead of the standalone server, and skips the Node 22 runtime (uses the dev environment's Node).

> **Dev-mode limitation**: in dev, `next dev` runs under **Electron's embedded Node 20.18**. pi SDK's bundled `undici` needs a newer Node and throws `webidl.util.markAsUncloneable is not a function`, crashing on session load. **Dev is only for pure front-end UI work**; anything touching the pi SDK server path (sending messages, running agents, xlsx preview, skill zip upload) must be tested in a **full build** (`npm run desktop:build`, Node 22 runtime).

### Known build pitfall: third-party deps (xlsx / adm-zip / mammoth) missing from standalone

**Symptom**: during `next build`, `@vercel/nft` follows dependency edges into system dirs (`C:\Program Files\WindowsApps\` — Bandisoft, PowerAutomate — and `~/.Neo4jDesktop`), emitting a stream of `⚠ Failed to copy traced files`. This **drops the affected route's entire traced set from `.next/standalone`**, silently leaving `xlsx`, `adm-zip`, and even the long-used `mammoth` out of the bundle. The build succeeds, but users get `Cannot find module 'xlsx'` at runtime (xlsx preview, skill zip upload, docx preview all break).

**Fix** (already in code):
1. `next.config.ts` `outputFileTracingExcludes` also excludes `C:\Program Files\**` and `(x86)` to reduce stray tracing at the source.
2. `desktop/ensure-standalone-chunks.cjs` gained `syncThirdPartyDeps()`: instead of relying on nft, it **copies `xlsx` / `adm-zip` / `mammoth` wholesale from the source `node_modules` into standalone**, then asserts all three are present — missing ones set `exitCode = 1` so the build fails rather than shipping a broken app.

**Verify**: the build log should show `third-party deps backfilled: xlsx (26), adm-zip (19), mammoth (144)` and `third-party deps present in standalone: ...`. A `STILL missing` warning means the backfill failed and the build aborts — don't ignore it.

---

## 3. File Responsibilities

| File | Purpose |
|------|---------|
| `desktop/main.cjs` | Electron main: single-instance lock, seed, port pick, spawn server, window, tree-kill on quit, error page |
| `desktop/lib/port.cjs` | `pickFreePort()`: listen on port 0 to let OS assign, then close and return |
| `desktop/lib/seed.cjs` | `seedIfMissing()`: mirrors SDK `getAgentDir()`, existsSync guard, never overwrites |
| `desktop/lib/spawn.cjs` | `startNextServer()` / `waitForReady()` / `killTree()`; env whitelist lives here |
| `desktop/preload.cjs` | v1 stub, no-op |
| `desktop/seed-models.json` | DeepSeek-only models.json template (apiKey as `$DEEPSEEK_API_KEY` placeholder) |
| `desktop/seed-settings.json` | Default provider/model/theme |
| `desktop/skip-deps.js` | electron-builder `beforeBuild` hook returning false to skip copying project node_modules into the app package |
| `desktop/win-eperm-patch.cjs` | Build-time monkey-patch of fs to swallow EPERM outside the project dir (see Pitfall 1) |
| `desktop/make-icon.mjs` | Build-time script: SVG → multi-size ICO |
| `desktop/node-runtime/node.exe` | Bundled Node 22.14.0 win-x64 binary (**not in git**; downloaded by `fetch-node.cjs`, see Pitfall 4) |
| `desktop/fetch-node.cjs` | Downloads node.exe from npmmirror before first build (idempotent) |
| `desktop/electron-builder.yml` | Build config (NSIS, perUser, asar:false, file mapping, extraResources) |

---

## 4. Build-time Pitfalls

### Pitfall 1: `EPERM scandir 'C:\Users\<user>\Application Data'` (or similar protected dirs)

**Symptom**: During `next build`, Next's `@vercel/nft` file tracer follows a symlink/junction into a Vista-era protected directory (`Application Data`, `My Documents`, …) and throws `EPERM`, aborting the build.

**Cause**: nft follows symlinks/junctions; those directories are off-limits to normal users.

**Fix (in place)**: `desktop/win-eperm-patch.cjs` monkey-patches `fs.readdir` / `readdirSync` / `readlink` / `lstat` / `stat` at build time to swallow EPERM/EACCES for paths **outside the project directory**. Injected via `NODE_OPTIONS="--require ./desktop/win-eperm-patch.cjs"` (see the `desktop:build:next` script in `package.json`).

**Cross-drive trap in `isOutsideProject`**: when the project is on D: and home is on C:, `path.relative(PROJECT_ROOT, target)` returns an **absolute path** (not `..`-prefixed), so "is outside" must be checked as:

```js
const rel = path.relative(PROJECT_ROOT, resolved);
const isOutside = rel.startsWith("..") || path.isAbsolute(rel) || rel === resolved;
```

Writing only `rel.startsWith("..")` misclassifies cross-drive paths as "inside" and the patch silently fails.

Also: when `readlink` hits a broken link, **do not return the path itself** (nft then reports "Recursive symlink detected") — `throw ENOENT` instead (it gets swallowed by the outer guard).

### Pitfall 2: electron-builder `files` single-file `{from, to}` object is ignored

**Symptom**: `{from: "desktop/main.cjs", to: "main.cjs"}` in `electron-builder.yml` is expected to rename a single file into the app package root, but the file is never copied, and the build fails with `Application entry file "main.cjs" does not exist`.

**Cause**: In app-builder-lib 25.1.8, single-file FileSets in the `files` array are **unreliable** (directory FileSets work fine). Tested: a directory FileSet `from: "desktop", to: "."` correctly flattens `desktop/main.cjs` → `resources/app/main.cjs` and `desktop/lib/` → `resources/app/lib/` (`getDestinationPath` uses `path.relative(src, file)`, stripping the `desktop/` prefix).

**Fix (in place)**: use **one directory FileSet** to flatten all of `desktop/` into the app root, with `filter` excluding build-only scripts:

```yaml
files:
  - from: desktop
    to: .
    filter:
      - "**/*"
      - "!make-icon.mjs"
      - "!win-eperm-patch.cjs"
      - "!electron-builder.yml"
  - from: .
    to: .
    filter:
      - "package.json"
```

**Do not add bare-string exclusions** (like `"!node_modules/**"`) to `files`: in a FileSet-only config, any bare string triggers a default matcher with `from=appDir`, which gets `**/*` prepended and pulls the **entire project** (`.next`, `app/`, `components/`, …) into the app package.

### Pitfall 3: 740 MB of duplicate node_modules in the app package

**Symptom**: After packaging, `resources/app/node_modules` is ~740 MB — a full copy of the project's production deps (next, pi SDK, aws-sdk, react, …). But `main.cjs` only uses `electron` + Node builtins + `./lib/*.cjs`, and the Next server runs from the standalone `node_modules` under `resources/server`. Pure dead weight.

**Cause**: electron-builder copies production deps into the app package based on `package.json` `dependencies` — a code path separate from the `files` config. `extraMetadata: { dependencies: {} }` **does not work**: `deepAssign` merges rather than replaces, and the copy reads the original `package.json` on disk, not the merged one.

**Fix (in place)**: `desktop/skip-deps.js` is a `beforeBuild` hook returning `false`, which sets `areNodeModulesHandledExternally=true` and skips the node_modules copy entirely. This is the official mechanism for the scenario. Safe: the sanity check only verifies `main.cjs` + `package.json` exist, not node_modules.

Effect: app package went from 740 MB → 51 KB.

### Pitfall 4: `webidl.util.markAsUncloneable is not a function` (API 500)

**Symptom**: Running the standalone server with `ELECTRON_RUN_AS_NODE=1` (Electron's embedded Node), the home page loads but any API route touching the pi SDK (`/api/models-config`, `/api/default-cwd`, …) returns 500 with `webidl.util.markAsUncloneable is not a function`.

**Cause**: Electron 33 embeds Node 20.18, whose `worker_threads`/undici lacks `markAsUncloneable` (added in Node 22+). Next 16.2.9's `@edge-runtime/primitives` calls it. Under `ELECTRON_RUN_AS_NODE` the server runs on Electron's embedded Node, so it blows up.

**Fix (in place)**: ship a separate Node 22 `node.exe` (`desktop/node-runtime/node.exe`, extracted from the official `node-v22.14.0-win-x64.zip`), packaged into `resources/node/`. `spawn.cjs` prefers it over electron.exe to run the server.

> The 80MB `node.exe` is **not committed to git** (see `.gitignore`). `desktop/fetch-node.cjs` downloads and extracts it from the npmmirror CDN during `npm run desktop:build` (skipped if already present — idempotent). You can also run `npm run desktop:fetch-node` standalone.

**How to update node.exe**: delete `desktop/node-runtime/node.exe`, bump `NODE_VERSION` in `desktop/fetch-node.cjs`, then run `npm run desktop:fetch-node`. Verify:

```bash
./desktop/node-runtime/node.exe --version    # should print the version
./desktop/node-runtime/node.exe -e "console.log(typeof require('worker_threads').markAsUncloneable)"  # should print function
```

When changing the Node major version, confirm `worker_threads.markAsUncloneable` is still a function (Next 16 edge-runtime depends on it).

### Pitfall 5: `Cannot find module './lib/port'`

**Symptom**: The packaged app crashes on launch with a dialog: `A JavaScript error occurred in the main process: Error: Cannot find module './lib/port'`.

**Cause**: Node's `require()` does **not** auto-resolve the `.cjs` extension (only `.js`/`.json`/`.node`). `require("./lib/port")` in `main.cjs` cannot find `lib/port.cjs`.

**Fix (in place)**: all `require`s of local `.cjs` modules carry the explicit extension: `require("./lib/port.cjs")`. There is a comment at the top of `desktop/main.cjs` explaining this.

### Pitfall 6: `rm: cannot remove 'dist-electron/...': Device or resource busy`

**Symptom**: `rm -rf dist-electron` fails when rebuilding, with "Device or resource busy".

**Cause**: A previous build's process didn't fully exit, or Pi Agent.exe is still running, or Windows Defender is scanning the freshly built exe and holding a handle.

**Fix**:

```bash
# Kill leftover processes
taskkill //F //IM "Pi Agent.exe"
taskkill //F //IM "electron.exe"

# Wait a few seconds before deleting (Defender releases handles with a delay)
sleep 5 && rm -rf dist-electron
```

### Pitfall 7: electron / winCodeSign binary download hangs (China network)

**Symptom**: During `npm install`, the electron binary download from GitHub hangs, or electron-builder's winCodeSign download times out.

**Fix (in place)**: the root `.npmrc` points at the npmmirror mirror:

```ini
electron_mirror=https://registry.npmmirror.com/-/binary/electron/
electron_builder_binaries_mirror=https://registry.npmmirror.com/-/binary/electron-builder-binaries/
```

Also set the env var at build time as a fallback:

```bash
export ELECTRON_BUILDER_BINARIES_MIRROR="https://registry.npmmirror.com/-/binary/electron-builder-binaries/"
```

### Pitfall 8: winCodeSign symlink creation fails

**Symptom**: packaging fails with a winCodeSign symlink error.

**Cause**: 7za creating symbolic links on Windows requires admin rights or Developer Mode.

**Fix**: enable Windows Developer Mode (Settings → Privacy & security → For developers), or run the build as administrator. Command-line enable:

```powershell
reg add "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\AppModelUnlock" /v AllowDevelopmentWithoutDevLicense /t REG_DWORD /d 1 /f
```

---

## 5. Distribution-time Pitfalls (what end users hit)

These are not the builder's fault — they happen **on other people's machines**. Knowing them helps with docs and support. See the [main README's "Troubleshooting" section](../README.md#troubleshooting-if-the-app-wont-start).

### User Pitfall A: Antivirus quarantines `node.exe` (highest risk)

Pi Agent spawns a `node.exe` child process from the user's `%LOCALAPPDATA%\Programs` directory — this **precisely matches** the "suspicious Node.js child process" detection rules of several security vendors (Elastic, Gurucul,, SigmaHQ all have rules for this pattern). Windows Defender's `Trojan:Win32/SuspExec.SE`, 360, Huorong may all flag it.

**User symptom**: blank window or error page on launch.

**Guidance for users**: restore `node.exe` from the antivirus quarantine and add the install folder to the trust/whitelist.

**Root-cause fix (not implemented)**: run the server via Electron's `utilityProcess.fork()` on Electron's own Node, eliminating the separate node.exe. But this re-opens the Node 22 vs Electron Node 20 edge-runtime incompatibility (see Pitfall 4) — likely needs a `markAsUncloneable` polyfill to fall back to `ELECTRON_RUN_AS_NODE`. Larger change; recommend observing real false-positive rates first.

### User Pitfall B: SmartScreen warning

Unsigned installers trigger "Windows protected your PC" on first run. Click "More info → Run anyway" — once per version. Unsigned files **start from zero reputation for every new version** (per Microsoft), so each version bump resets reputation. For broad distribution, consider code signing (an EV certificate grants immediate reputation).

### User Pitfall C: Slow first launch / timeout blank screen

The first launch warms up the bundled server — 10–30s is normal, longer if antivirus is real-time scanning. Beyond ~45s the app shows a retry page (`loadErrorPage` in `main.cjs`); click "Retry". This error page only exists because `main.cjs` wraps `startNextServer` / `waitForReady` / `loadURL` in try/catch — without it an unhandled `ERR_CONNECTION_REFUSED` rejection would leave a blank window.

### User Pitfall D: Coexistence with an installed pi CLI

No conflict. The desktop app shares `~/.pi/agent` with the pi CLI; the seed has an `existsSync` guard and never overwrites. Both can even run at once (different ports). For isolation, set the `PI_CODING_AGENT_DIR` env var. See the [main README](../README.md#desktop-app-windows).

---

## 6. Non-issues (confirmed safe)

| Concern | Verdict |
|---------|---------|
| Windows firewall "allow access" prompt | No. Only listens on 127.0.0.1 (loopback); Windows firewall does not filter loopback by default |
| Electron loading http://127.0.0.1 being restricted | No. BrowserWindow loadURL over HTTP localhost is a standard pattern |
| Same-port fetch CORS | No. Page and API share a port = same origin |
| Win10 1909 can't run it | It can. Electron 33 only requires "Windows 10 or later", no build-number floor |
| `seed.cjs` `mode: 0o600` | Windows ignores Unix permission bits silently; no error, just no effect |

---

## 7. Related Docs

- [Main README (English)](../README.md) — quick start, desktop overview, troubleshooting
- [Main README (Chinese)](../README.zh-CN.md)
- [Release checklist](./release.md) — npm + GitHub Release flow
