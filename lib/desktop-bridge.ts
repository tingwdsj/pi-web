// Browser ↔ Electron desktop bridge.
//
// The desktop app (desktop/main.cjs + preload.cjs) injects a `piDesktop`
// global on window via contextBridge. These helpers let web UI call desktop
// capabilities (open a file/folder with the OS) when present, and gracefully
// no-op / report absence when running in a plain browser (e.g. `npm run dev`
// viewed in Chrome, where shell access is unavailable for security reasons).
//
// Desktop-side IPC handlers are added separately in main.cjs/preload.cjs.

declare global {
  interface Window {
    piDesktop?: {
      // Open a file with its OS default application (shell.openPath).
      openFile?: (filePath: string) => Promise<{ ok: boolean; error?: string }>;
      // Open a directory in the OS file manager (shell.openPath on a folder).
      openFolder?: (dirPath: string) => Promise<{ ok: boolean; error?: string }>;
      // Show the OS native directory picker (dialog.showOpenDialog).
      pickDirectory?: () => Promise<PickDirectoryResult>;
      // Open an external http(s) URL in the system browser.
      openExternal?: (url: string) => Promise<void>;
    };
  }
}

export interface PickDirectoryResult {
  ok: boolean;
  path?: string;
  canceled?: boolean;
  error?: string;
}

/** True when running inside the Electron desktop shell. */
export function isDesktop(): boolean {
  return typeof window !== "undefined" && !!window.piDesktop;
}

/**
 * Open a file with the OS default application. Returns {ok:false} in a plain
 * browser (no desktop bridge) so callers can fall back to download / hide UI.
 */
export async function openFileLocally(
  filePath: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    if (window.piDesktop?.openFile) return await window.piDesktop.openFile(filePath);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  return { ok: false, error: "desktop-bridge-unavailable" };
}

/**
 * Open a directory in the OS file manager. Returns {ok:false} in a plain
 * browser.
 */
export async function openFolderLocally(
  dirPath: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    if (window.piDesktop?.openFolder) return await window.piDesktop.openFolder(dirPath);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  return { ok: false, error: "desktop-bridge-unavailable" };
}

/**
 * Show the OS native directory picker and return the chosen path. Returns
 * { ok:false, canceled:true } when the user dismisses the dialog. Returns
 * { ok:false, error:"desktop-bridge-unavailable" } in a plain browser.
 */
export async function pickDirectory(): Promise<PickDirectoryResult> {
  try {
    if (window.piDesktop?.pickDirectory) return await window.piDesktop.pickDirectory();
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  return { ok: false, error: "desktop-bridge-unavailable" };
}

export {};
