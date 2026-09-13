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
// Last-known app URL, so the macOS "activate" handler can reopen a window
// against the still-running server after the user closed the last window.
let currentPort = null;
let currentServerReady = false;
// The default session is shared by all windows; attach will-download once.
let downloadHandlerAttached = false;

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

// Validate a local filesystem path before handing it to shell.openPath.
// The "open locally" buttons are user-initiated (an explicit click), so the
// intent is the same as double-clicking the file in Explorer — we don't need
// an allow-list. We only reject:
//   - network (UNC) paths like \\server\share — opening those can trigger
//     silent NTLM auth / unexpected handlers, and they're never legitimate
//     local-preview targets;
//   - paths containing NUL bytes or control chars (path-injection / garbage).
// Returns { ok, resolved, error? }.
function validateLocalPath(raw) {
  if (typeof raw !== "string" || raw.length === 0) {
    return { ok: false, error: "invalid-path" };
  }
  if (/[\x00-\x1f]/.test(raw)) {
    return { ok: false, error: "invalid-path" };
  }
  const resolved = path.resolve(raw);
  // UNC (\\server\share or //server/share) — reject before openPath sees it.
  if (/^(?:\\\\|\/\/)[^/\\]/.test(resolved)) {
    return { ok: false, error: "network-path-not-allowed" };
  }
  return { ok: true, resolved };
}

// Open a file with its OS default application (需求2: "本地打开").
ipcMain.handle("open-file", async (_event, filePath) => {
  const v = validateLocalPath(filePath);
  if (!v.ok) return { ok: false, error: v.error };
  const err = await shell.openPath(v.resolved);
  // shell.openPath returns "" on success, or an error message string on failure.
  return err ? { ok: false, error: err } : { ok: true };
});

// Open a directory in the OS file manager (需求3: "在文件管理器中打开").
ipcMain.handle("open-folder", async (_event, dirPath) => {
  const v = validateLocalPath(dirPath);
  if (!v.ok) return { ok: false, error: v.error };
  const err = await shell.openPath(v.resolved);
  return err ? { ok: false, error: err } : { ok: true };
});

// Show the OS native directory picker and return the chosen path
// (新需求: "选择项目目录" 下拉里的 "浏览本地文件夹" 项).
// Returns { ok:true, path } on choice, or { ok:false, canceled:true } when the
// user dismisses the dialog. Desktop-only — browsers cannot read a real disk
// path from a picker, so the UI button is hidden when the bridge is absent.
ipcMain.handle("pick-directory", async () => {
  if (!mainWindow) return { ok: false, error: "no-window" };
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "选择项目目录",
    properties: ["openDirectory"],
  });
  if (result.canceled || !result.filePaths.length) {
    return { ok: false, canceled: true };
  }
  return { ok: true, path: result.filePaths[0] };
});

// Show a local diagnostic page when the Next server fails to start or load.
// Uses a data: URL so it works even if the server never came up. The Retry
// button reloads the real app URL (useful if the server was just slow); if
// that still fails, the user at least sees what went wrong instead of a blank
// window or an unhandled ERR_CONNECTION_REFUSED rejection.
function loadErrorPage(win, port, detail) {
  const safeDetail = String(detail).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const appUrl = `http://127.0.0.1:${port}/`;
  const isMac = process.platform === "darwin";
  const runtimePath = isMac ? "Resources/node/node" : "resources\\node\\node.exe";
  const hints = isMac
    ? `如果反复出现:① 确认应用已放入「应用程序」且 <code>${runtimePath}</code> 有可执行权限(<code>chmod +x</code>);② 若提示“已损坏”,先执行 <code>xattr -rd com.apple.quarantine /Applications/Pi\\ Agent.app</code>;③ 关闭其他占用资源的程序后重启 Pi Agent;④ 重新安装。`
    : `如果反复出现:① 确认安装目录未被杀毒软件隔离(尤其 <code>${runtimePath}</code>);② 关闭其他占用资源的程序后重启 Pi Agent;③ 重新安装。`;
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
<p>Pi Agent 需要启动一个本地服务来加载界面,但它没有在限定时间内就绪。这通常是暂时的(首次启动较慢${isMac ? "" : ",或杀毒软件正在扫描"})。</p>
<div class="detail">${safeDetail}</div>
<button onclick="location.href='${appUrl}'">重试加载</button>
<button onclick="location.reload()">刷新本页</button>
<p class="hint">${hints}</p>
</div></body></html>`;
  win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
}

// Install the application menu.
//   - macOS keeps a menu built from standard roles: setting it to null also
//     removes the Edit menu, which is what provides Cmd+C / Cmd+V / Cmd+X /
//     Cmd+A and Cmd+Q / Cmd+W. Without it, text editing in the chat box breaks.
//   - Windows/Linux keep the bar hidden (autoHideMenuBar) and menu removed.
function installApplicationMenu() {
  if (process.platform === "darwin") {
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        { role: "appMenu" },
        { role: "editMenu" },
        { role: "viewMenu" },
        { role: "windowMenu" },
      ])
    );
  } else {
    Menu.setApplicationMenu(null);
  }
}

// Create the main window and wire up its per-window handlers. Shared by
// bootstrap() and the macOS "activate" handler (dock-icon click after the last
// window was closed — the Next server stays alive, so we just open a new
// window against the same port).
async function openMainWindow(port, serverReady) {
  installApplicationMenu();

  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 900,
    minHeight: 600,
    title: "Pi Agent",
    // .icns on macOS, .ico on Windows. Both are flattened to the app root by
    // the electron-builder `files` FileSet (see electron-builder.yml).
    icon: path.join(__dirname, process.platform === "darwin" ? "icon.icns" : "icon.ico"),
    autoHideMenuBar: true,
    backgroundColor: "#0a0a0a",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow = win;

  // Open external links in the system browser; keep localhost in-app.
  win.webContents.setWindowOpenHandler(({ url }) => {
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
  //
  // Attached once per session: all windows share Electron's default session,
  // so re-adding on every new window would fire the dialog N times.
  if (!downloadHandlerAttached) {
    downloadHandlerAttached = true;
    win.webContents.session.on("will-download", (_event, item) => {
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
  }

  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });

  if (serverReady) {
    try {
      await win.loadURL(`http://127.0.0.1:${port}/`);
    } catch (e) {
      console.error("[pi-desktop] loadURL failed:", e.message);
      loadErrorPage(win, port, e.message);
    }
  } else {
    // Server never came up — show a diagnostic page instead of a blank window
    // (which would otherwise throw an unhandled ERR_CONNECTION_REFUSED).
    loadErrorPage(win, port, "Server did not become ready within the timeout.");
  }
  return win;
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
    // Use the shipped Node 22 runtime (resources/node/node.exe on Windows,
    // resources/node/node on macOS) to run the standalone server — Electron
    // 33's embedded Node 20.18 is too old for Next 16.2.9's edge-runtime
    // (markAsUncloneable). See spawn.cjs and electron-builder.yml.
    const nodeBinary = process.platform === "win32" ? "node.exe" : "node";
    const nodePath = path.join(process.resourcesPath, "node", nodeBinary);
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
  currentPort = port;
  currentServerReady = serverReady;
  await openMainWindow(port, serverReady);
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

  // macOS: clicking the dock icon with no open windows should reopen the UI.
  // The Next server is kept alive, so we just open a fresh window against the
  // same port instead of bootstrapping a second server.
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0 && currentPort) {
      openMainWindow(currentPort, currentServerReady).catch((e) =>
        console.error("[pi-desktop] activate: failed to reopen window:", e.message)
      );
    }
  });

  app.on("before-quit", () => {
    if (nextChild && nextChild.pid) {
      killTree(nextChild.pid);
    }
    nextChild = null;
  });
}
