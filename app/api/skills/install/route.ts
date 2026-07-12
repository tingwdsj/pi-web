import { NextResponse } from "next/server";
import { runNpx } from "@/lib/npx";

export const dynamic = "force-dynamic";

// Match any CSI/OSC/SS3 escape sequence (colors, cursor moves, erase line,
// hide/show cursor, etc.) — skills CLI renders an animated spinner TTY output
// full of these. The old regex only stripped color codes ([...m) and left
// cursor-control sequences ([?25l, [1G[J, ...) in the message, making the
// error nearly unreadable.
const ANSI_RE = /\x1B\[[0-9;?]*[A-Za-z]|\x1B\][^\x07\x1B]*(\x07|\x1B\\)|\x1B[=>]/g;

// Collapse the spinner's repeated redraws ("Cloning repository", "Cloning repository.",
// "Cloning repository..", ...) into a single representative line.
function cleanNpxOutput(raw: string): string {
  const stripped = raw.replace(ANSI_RE, "");
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const line of stripped.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Dedup spinner frames that differ only by trailing dots.
    const key = trimmed.replace(/\.+$/, "").replace(/\s+/g, " ");
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(trimmed);
  }
  return lines.join("\n");
}

// Detect git-clone/network failures (common when GitHub is unreachable from
// the user's network) and append a readable hint.
function diagnoseFailure(output: string): string | null {
  if (/Failed to clone|Connection was reset|Connection timed out|the remote end hung up|RPC failed|expected flush after ref listing/i.test(output)) {
    return "技能安装需要从 GitHub 克隆仓库(git clone),但当前网络无法访问 GitHub(连接被重置/超时)。请检查网络或为 git 配置代理后重试。";
  }
  return null;
}

// POST /api/skills/install  body: { package: string; scope: "global" | "project"; cwd?: string }
export async function POST(req: Request) {
  try {
    const { package: pkg, scope, cwd } = await req.json() as { package?: string; scope?: string; cwd?: string };
    if (!pkg?.trim()) return NextResponse.json({ error: "package required" }, { status: 400 });

    const isGlobal = scope !== "project";
    const args = ["skills", "add", pkg.trim(), "-y", "--agent", "pi"];
    if (isGlobal) args.push("-g");

    console.log(`[skills/install] running: npx ${args.join(" ")}`);
    const { stdout, stderr } = await runNpx(args, {
      timeout: 60000,
      cwd: !isGlobal && cwd ? cwd : undefined,
      env: { ...process.env, FORCE_COLOR: "0" },
    });

    const output = cleanNpxOutput(stdout + stderr);
    const success = /Installation complete|Installed \d+ skill/.test(output);
    if (!success) {
      const hint = diagnoseFailure(output);
      return NextResponse.json(
        { error: hint ? `${output.slice(-400)}\n\n${hint}` : (output.slice(-400) || "Install failed") },
        { status: 500 },
      );
    }
    return NextResponse.json({ success: true, output });
  } catch (e: unknown) {
    const err = e as { message?: string };
    // spawnCapture rejects with a single Error whose message already includes
    // the command, exit status, and captured stderr/stdout.
    const output = cleanNpxOutput(err.message ?? String(e));
    const hint = diagnoseFailure(output);
    return NextResponse.json(
      { error: hint ? `${output}\n\n${hint}` : output },
      { status: 500 },
    );
  }
}
