import { existsSync } from "fs";
import { dirname, join } from "path";
import { execPath } from "process";
// cross-spawn ships no type declarations.
// @ts-expect-error - no @types/cross-spawn available
import crossSpawn from "cross-spawn";

type CrossSpawnChild = {
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  once(event: "error", listener: (err: Error) => void): unknown;
  once(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  kill(): void;
};

/**
 * Locate `npx-cli.js` shipped with the running Node.js installation.
 *
 * On Windows the `npx` on PATH is actually `npx.cmd`, which Node.js (since
 * 20.12 due to CVE-2024-27980) refuses to spawn from `execFile`/`spawn`
 * without `shell: true`. Going through a shell reintroduces quoting bugs for
 * user-supplied args. Instead we find the real `npx-cli.js` and invoke it
 * directly via the current `node` binary, which works identically on every
 * platform and needs no shell.
 */
function findNpxCli(): string | null {
  const nodeDir = dirname(execPath);
  const candidates = [
    // Windows MSI installer layout: node.exe and node_modules share a dir
    join(nodeDir, "node_modules", "npm", "bin", "npx-cli.js"),
    // Unix layout: .../bin/node + .../lib/node_modules/npm/bin/npx-cli.js
    join(nodeDir, "..", "lib", "node_modules", "npm", "bin", "npx-cli.js"),
  ];
  for (const p of candidates) {
    try {
      if (existsSync(p)) return p;
    } catch {
      // ignore
    }
  }
  return null;
}

export interface RunNpxOptions {
  timeout?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface RunNpxResult {
  stdout: string;
  stderr: string;
}

/**
 * Spawn a command, capturing stdout/stderr, resolving on exit 0 and rejecting
 * with a combined message on non-zero exit. Uses `cross-spawn` so Windows
 * `.cmd` shims (npx.cmd / npm.cmd) resolve without `shell: true` and without
 * the quoting hazards a shell introduces for user-supplied args.
 */
function spawnCapture(
  command: string,
  args: string[],
  opts: RunNpxOptions,
): Promise<RunNpxResult> {
  return new Promise((resolvePromise, reject) => {
    const child = crossSpawn(command, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["ignore", "pipe", "pipe"],
    }) as CrossSpawnChild;
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = typeof opts.timeout === "number"
      ? setTimeout(() => {
          timedOut = true;
          child.kill();
        }, opts.timeout)
      : undefined;
    child.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
    child.once("error", (err: Error) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.once("close", (code: number | null, signal: NodeJS.Signals | null) => {
      if (timer) clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`${command} ${args.join(" ")} timed out after ${opts.timeout}ms`));
        return;
      }
      if (code === 0) {
        resolvePromise({ stdout, stderr });
        return;
      }
      const status = code === null ? `signal ${signal ?? "unknown"}` : `code ${code}`;
      reject(new Error(`${command} ${args.join(" ")} failed with ${status}: ${stderr || stdout}`));
    });
  });
}

/**
 * Cross-platform wrapper for invoking `npx <args>` without ever using a
 * shell, so user-controlled arguments are never interpreted as shell syntax.
 *
 * Resolution order:
 *   1. Bundled npx-cli.js + current Node — the normal web/CLI path. Runs npx
 *      directly off the installed npm, no shell.
 *   2. `npx` via cross-spawn — used when npx-cli.js can't be located (notably
 *      the packaged desktop app, whose `process.execPath` is the Electron
 *      binary and which ships no npm). cross-spawn resolves `npx.cmd` on
 *      Windows without a shell. Requires Node/npm to be on the user's PATH,
 *      which is the same prerequisite plugin install already needs (it shells
 *      out to npm.cmd). NOTE: `runNpx` is used for the `skills` CLI — an
 *      independent npm package fetched on demand by npx — so we must run a
 *      real npx here, not the bundled pi CLI.
 */
export async function runNpx(args: string[], opts: RunNpxOptions = {}): Promise<RunNpxResult> {
  const npxCli = findNpxCli();
  if (npxCli) {
    return spawnCapture(execPath, [npxCli, ...args], opts);
  }
  return spawnCapture("npx", args, opts);
}
