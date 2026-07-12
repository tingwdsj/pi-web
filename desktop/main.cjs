"use strict";

// Pi Agent desktop main process.
//
// Lifecycle:
//   1. Single-instance lock (second launch focuses the existing window).
//   2. On ready: seed first-run data -> pick free port -> spawn Next server
//      (standalone in production, `next dev` in dev) -> wait for it to respond
//      -> open a BrowserWindow pointing at it.
//   3. On quit: tree-kill the Next child so it never outlives the app.
//
// Dev mode is toggled by PI_DESKTOP_DEV=1 (see package.json desktop:dev script):
// it runs `next dev` on a fixed port instead of the standalone server, so you
// get hot reload during development.

const { app, BrowserWindow, shell, Menu, ipcMain, dialog } = require("electron");
const path = require("path");
const { spawn } = require("child_process");
// NOTE: lib helpers are .cjs files. Node's require() does NOT auto-resolve the
// .cjs extension (only .js/.json/.node), so the explicit extension is required
// — without it the packaged app throws "Cannot find module './lib/port'" at
// startup. (Verified: require.extensions has no .cjs entry.)
const { pickFreePort } = require("./lib/port.cjs");
const { seedIfMissing } = require("./lib/seed.cjs");
const { startNextServer, waitForReady, killTree } = require("./lib/spawn.cjs");

const isDev = !!process.env.PI_DESKTOP_DEV;
const DEV_PORT = 30141;

let mainWindow = null;
let nextChild = null;

function log(msg) {
  console.log(`[pi-desktop] ${msg}`);
}

// Open external URLs in the system browser. The preload script routes non-local
// <a> clicks here. Scheme is whitelisted to http/https to prevent malicious
// content (e.g. an LLM-emitted markdown link) from triggering javascript:/file:
// via shell.openExternal, which on Windows can execute unexpected handlers.
ipcMain.handle("open-external", (_event, url) => {
  try {
    const parsed = new URL(String(url));
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      shell.openExternal(parsed.href);
    }
  } catch {
    /* invalid URL — ignore */
  }
});

// Show a local diagnostic page when the Next server fails to start or load.
// Uses a data: URL so it works even if the server never came up. The Retry
// button reloads the real app URL (useful if the server was just slow); if
// that still fails, the user at least sees what went wrong instead of a blank
// window or an unhandled ERR_CONNECTION_REFUSED rejection.
function loadErrorPage(win, port, detail) {
  const safeDetail = String(detail).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const appUrl = `http://127.0.0.1:${port}/`;
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Pi Agent — 启动失败</title>
<style>
  body{font-family:-apple-system,Segoe UI,sans-serif;background:#0a0a0a;color:#e5e5e5;margin:0;padding:48px 24px;display:flex;justify-content:center}
  .card{max-width:560px;line-height:1.6}
  h1{font-size:20px;margin:0 0 16px;color:#fff}
  p{margin:0 0 12px;color:#a0a0a0}
  code{background:#1a1a1a;padding:2px 6px;border-radius:4px;color:#67e8f9;font-size:13px}
  .detail{background:#1a1a1a;border:1px solid #333;padding:12px 14px;border-radius:6px;font-size:13px;color:#fca5a5;margin:16px 0;word-break:break-all;white-space:pre-wrap}
  button{background:#0e7490;color:#fff;border:0;padding:10px 20px;border-radius:6px;font-size:14px;cursor:pointer;margin-right:8px}
  button:hover{background:#0891b2}
  .hint{font-size:12px;color:#666;margin-top:24px}
</style></head><body><div class="card">
<h1>Pi Agent 无法启动内置服务</h1>
<p>Pi Agent 需要启动一个本地服务来加载界面,但它没有在限定时间内就绪。这通常是暂时的(首次启动较慢,或杀毒软件正在扫描)。</p>
<div class="detail">${safeDetail}</div>
<button onclick="location.href='${appUrl}'">重试加载</button>
<button onclick="location.reload()">刷新本页</button>
<p class="hint">如果反复出现:① 确认安装目录未被杀毒软件隔离(尤其 <code>resources\\node\\node.exe</code>);② 关闭其他占用资源的程序后重启 Pi Agent;③ 重新安装。</p>
</div></body></html>`;
  win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
}

async function bootstrap() {
  // 1. Seed first-run data (models.json + settings.json) if missing.
  try {
    const { agentDir, seeded } = seedIfMissing();
    if (seeded.length) {
      log(`Seeded ${seeded.join(", ")} -> ${agentDir}`);
    } else {
      log(`Using existing config at ${agentDir}`);
    }
  } catch (e) {
    console.error("[pi-desktop] First-run seed failed:", e.message);
  }

  // 2. Pick a port (fixed in dev for hot reload, free in production).
  const port = isDev ? DEV_PORT : await pickFreePort();
  log(`Using port ${port}`);

  // 3. Start the Next server.
  if (isDev) {
    const projectRoot = path.resolve(__dirname, "..");
    let nextBin;
    try {
      nextBin = require.resolve("next/dist/bin/next", { paths: [projectRoot] });
    } catch {
      console.error("[pi-desktop] Could not resolve next bin in dev mode. Run `npm install` first.");
      app.quit();
      return;
    }
    nextChild = spawn(process.execPath, [nextBin, "dev", "-p", String(port)], {
      cwd: projectRoot,
      env: { ...process.env, PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    nextChild.stdout.on("data", (d) => process.stdout.write(`[next] ${d}`));
    nextChild.stderr.on("data", (d) => process.stderr.write(`[next] ${d}`));
  } else {
    const appDir = path.join(process.resourcesPath, "server");
    // Use the shipped Node 22 runtime (resources/node/node.exe) to run the
    // standalone server — Electron 33's embedded Node 20.18 is too old for
    // Next 16.2.9's edge-runtime (markAsUncloneable). See spawn.cjs.
    const nodePath = path.join(process.resourcesPath, "node", "node.exe");
    try {
      nextChild = startNextServer(appDir, port, nodePath);
    } catch (e) {
      // startNextServer throws synchronously if server.js / node.exe is missing
      // (e.g. antivirus quarantined files, or a corrupt install). Without this
      // guard the rejection goes unhandled and the window never opens.
      console.error("[pi-desktop] Failed to spawn server:", e.message);
      nextChild = null;
    }
  }

  // 4. Wait for it to be ready (longer timeout in dev for first compile).
  let serverReady = false;
  if (nextChild) {
    try {
      await waitForReady(port, isDev ? 120000 : 45000);
      serverReady = true;
      log("Server ready");
    } catch (e) {
      console.error("[pi-desktop] Server failed to start:", e.message);
    }
  }

  // 5. Open the window.
  Menu.setApplicationMenu(null);
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 900,
    minHeight: 600,
    title: "Pi Agent",
    icon: path.join(__dirname, "icon.ico"),
    autoHideMenuBar: true,
    backgroundColor: "#0a0a0a",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (serverReady) {
    try {
      await mainWindow.loadURL(`http://127.0.0.1:${port}/`);
    } catch (e) {
      console.error("[pi-desktop] loadURL failed:", e.message);
      loadErrorPage(mainWindow, port, e.message);
    }
  } else {
    // Server never came up — show a diagnostic page instead of a blank window
    // (which would otherwise throw an unhandled ERR_CONNECTION_REFUSED).
    loadErrorPage(mainWindow, port, "Server did not become ready within the timeout.");
  }

  // Open external links in the system browser; keep localhost in-app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http://127.0.0.1:") || url.startsWith("http://localhost:")) {
      return { action: "allow" };
    }
    shell.openExternal(url);
    return { action: "deny" };
  });

  // 接管文件下载（会话 HTML 导出走 <a download>，触发 will-download）。
  // 不接管时 Electron 的默认下载行为在部分环境下会出现：保存对话框弹出、
  // 用户选目录点保存后文件却不落地（下载项被中断/取消，且无任何提示）。
  // 这里显式弹出保存对话框并把用户选择的路径设为保存目标，同时打日志
  // 便于诊断；若用户取消则主动取消下载项，避免残留。
  mainWindow.webContents.session.on("will-download", (_event, item) => {
    const suggested = item.getFilename() || "download.html";
    log(`[download] will-download: suggested="${suggested}" mime="${item.getMimeType()}" url="${item.getURL()}"`);

    const chosen = dialog.showSaveDialogSync(mainWindow, {
      title: "保存导出文件",
      defaultPath: suggested,
    });

    if (!chosen) {
      log(`[download] user cancelled save dialog`);
      item.cancel();
      return;
    }

    log(`[download] save path = ${chosen}`);
    item.setSavePath(chosen);

    item.on("done", (_e, state) => {
      log(`[download] done state="${state}" path="${item.getSavePath()}"`);
    });
    item.on("updated", (_e, state) => {
      log(`[download] updated state="${state}"`);
    });
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// --- App lifecycle ---

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(bootstrap);

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", () => {
    if (nextChild && nextChild.pid) {
      killTree(nextChild.pid);
    }
    nextChild = null;
  });
}
