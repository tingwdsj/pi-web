"use strict";

// Spawn the Next.js standalone server, wait for it to be ready, and kill its
// process tree on shutdown.
//
// In production we spawn .next/standalone/server.js directly with `node` — this
// is self-contained (ships its own traced node_modules) and does not rely on the
// `next` CLI resolving at runtime. We do NOT reuse bin/pi-web.js because that
// script opens a browser itself and cannot report a dynamically-assigned port.

const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const http = require("http");

// Poll a lightweight endpoint until the server responds, or reject after timeoutMs.
// /api/home returns { home: homedir() } — minimal work, fast 200.
function waitForReady(port, timeoutMs = 15000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    function attempt() {
      if (Date.now() - start > timeoutMs) {
        return reject(new Error(`Server not ready within ${timeoutMs}ms on port ${port}`));
      }
      const req = http.get(
        { host: "127.0.0.1", port, path: "/api/home", timeout: 2000 },
        (res) => {
          res.resume();
          if (res.statusCode && res.statusCode < 500) return resolve();
          setTimeout(attempt, 300);
        }
      );
      req.on("error", () => setTimeout(attempt, 300));
      req.on("timeout", () => {
        req.destroy();
        setTimeout(attempt, 300);
      });
    }
    attempt();
  });
}

// Build a sanitized env for the Next server child process. We do NOT blindly
// spread process.env — a user's machine may carry NODE_OPTIONS / NODE_PATH /
// ELECTRON_* / npm_* vars (left over from a dev shell, an installer, or a
// globally-set variable) that can break or subtly alter the standalone server.
// We pass through only what the server actually needs: OS/path resolution,
// temp dirs, locale, and pi's own PI_CODING_AGENT_DIR (so it shares the data
// dir with the main process / seed). NODE_ENV/PORT/HOSTNAME are set explicitly.
function buildServerEnv() {
  const allow = new Set([
    // OS / shell / path resolution
    "PATH", "PATHEXT", "SYSTEMROOT", "SystemRoot", "WINDIR", "windir",
    "COMSPEC", "ComSpec", "APPDATA", "AppData", "LOCALAPPDATA", "LocalAppData",
    "PROGRAMDATA", "ProgramData", "PROGRAMFILES", "ProgramFiles",
    "PROGRAMFILES(X86)", "ProgramFiles(x86)", "USERPROFILE", "USERDOMAIN",
    "USERNAME", "COMPUTERNAME", "HOMEDRIVE", "HOMEPATH",
    // Temp dirs (Next/pi may write here)
    "TEMP", "TMP", "TMPDIR",
    // Locale
    "LANG", "LC_ALL", "LC_CTYPE",
    // pi agent data dir (coexist with CLI / honor user override)
    "PI_CODING_AGENT_DIR",
    // Proxy (user may need it for outbound LLM calls; harmless if absent)
    "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
  ]);
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (allow.has(k)) env[k] = v;
  }
  env.NODE_ENV = "production";
  return env;
}

// appDir = directory containing the standalone server.js (i.e. .next/standalone
// in dev, or process.resourcesPath/app/server in the packaged app).
// nodePath = optional path to a real node executable. In the packaged app we
// ship Node 22 at resources/node/node.exe and use it to run server.js, because
// Electron 33's embedded Node 20.18 is too old for Next 16.2.9's edge-runtime
// (see electron-builder.yml comment). In dev we fall back to process.execPath
// (the dev electron or a system node) with ELECTRON_RUN_AS_NODE.
function startNextServer(appDir, port, nodePath) {
  const serverJs = path.join(appDir, "server.js");
  if (!fs.existsSync(serverJs)) {
    throw new Error(`Standalone server.js not found at ${serverJs}`);
  }
  const useShippedNode = nodePath && fs.existsSync(nodePath);
  const exec = useShippedNode ? nodePath : process.execPath;
  const env = buildServerEnv();
  env.PORT = String(port);
  env.HOSTNAME = "127.0.0.1";
  if (!useShippedNode) {
    // Fall back: make electron.exe behave as a vanilla Node runtime. NOTE this
    // uses Electron's embedded Node 20.18, which is too old for Next 16.2.9's
    // edge-runtime — only used as a dev fallback or if node.exe is missing.
    env.ELECTRON_RUN_AS_NODE = "1";
  }
  // When useShippedNode, ELECTRON_RUN_AS_NODE is not in env at all (buildServerEnv
  // doesn't pass it through), so the real node.exe runs as a normal Node runtime.
  const child = spawn(exec, [serverJs], {
    cwd: appDir,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: false,
  });

  child.stdout.on("data", (d) => process.stdout.write(`[next] ${d}`));
  child.stderr.on("data", (d) => process.stderr.write(`[next] ${d}`));
  return child;
}

// Kill a process tree. Plain child.kill() on Windows does NOT kill children;
// taskkill /T kills the whole tree recursively. /F forces it.
function killTree(pid) {
  if (!pid) return;
  if (process.platform === "win32") {
    try {
      spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
        stdio: "ignore",
        shell: true,
      });
    } catch {
      /* best effort */
    }
  } else {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* best effort */
    }
  }
}

module.exports = { startNextServer, waitForReady, killTree };
