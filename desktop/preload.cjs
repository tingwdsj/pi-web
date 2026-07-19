"use strict";

// Preload: intercept external link clicks so they open in the system browser
// instead of navigating the app's BrowserWindow away from the chat UI.
//
// Problem: chat message bodies are rendered by react-markdown as plain
// <a href="https://..."> (no target="_blank"). A click navigates the current
// window to the external URL, and since the menu bar is hidden there's no
// back button — the user is stuck. setWindowOpenHandler only catches
// window.open()/target="_blank", not plain <a> navigation. So we catch <a>
// clicks here at the capture phase and route non-local URLs through the main
// process via shell.openExternal.
//
// Local URLs (the app's own 127.0.0.1/localhost server, and about:) are left
// to navigate normally.

const { contextBridge, ipcRenderer } = require("electron");

function isLocalNav(href) {
  if (!href) return true;
  return (
    /^(https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$))/i.test(href) ||
    href.startsWith("about:")
  );
}

// Capture phase so we beat any per-element handlers react-markdown might add.
// a.href is the absolutized URL (the browser resolves relative hrefs for us),
// and closest("a") covers clicks on nested children (code/img inside an <a>).
window.addEventListener(
  "click",
  (e) => {
    const a = e.target && e.target.closest && e.target.closest("a");
    if (!a || !a.href) return;
    if (isLocalNav(a.href)) return; // in-app navigation: allow
    e.preventDefault();
    e.stopPropagation();
    ipcRenderer.invoke("open-external", a.href);
  },
  true
);

// Middle-click (new-tab intent) on an external link: also open externally,
// don't let it spawn an in-app navigation.
window.addEventListener(
  "auxclick",
  (e) => {
    if (e.button !== 1) return; // 1 = middle
    const a = e.target && e.target.closest && e.target.closest("a");
    if (!a || !a.href || isLocalNav(a.href)) return;
    e.preventDefault();
    ipcRenderer.invoke("open-external", a.href);
  },
  true
);

contextBridge.exposeInMainWorld("piDesktop", {
  openExternal: (url) => ipcRenderer.invoke("open-external", url),
  // Open a file with its OS default application (需求2).
  openFile: (filePath) => ipcRenderer.invoke("open-file", filePath),
  // Open a directory in the OS file manager (需求3).
  openFolder: (dirPath) => ipcRenderer.invoke("open-folder", dirPath),
  // Show the OS directory picker, return chosen path (项目目录下拉).
  pickDirectory: () => ipcRenderer.invoke("pick-directory"),
});
