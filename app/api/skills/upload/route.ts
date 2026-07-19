import { NextResponse } from "next/server";
import path from "path";
import { promises as fs } from "fs";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { isFilePathAllowed, getAllowedFileRoots } from "@/lib/file-access";
import { readZipEntries, parseSkillZip } from "@/lib/skill-zip";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_ZIP_BYTES = 10 * 1024 * 1024; // 10 MB upload cap

// POST /api/skills/upload  multipart: "scope"(global|project), "cwd"(project only), "file"=zip
// Validates the zip, refuses path traversal / bombs, errors on name conflicts,
// then extracts into the global or project skills dir.
export async function POST(req: Request) {
  try {
    const form = await req.formData();
    const scope = String(form.get("scope") ?? "global");
    const isGlobal = scope !== "project";
    const cwd = String(form.get("cwd") ?? "");

    if (!isGlobal) {
      if (!cwd) return NextResponse.json({ error: "项目作用域需要 cwd" }, { status: 400 });
      const allowedRoots = await getAllowedFileRoots();
      if (!isFilePathAllowed(cwd, allowedRoots)) {
        return NextResponse.json({ error: "Access denied" }, { status: 403 });
      }
    }

    const file = form.get("file");
    if (typeof File === "undefined" || !(file instanceof File)) {
      return NextResponse.json({ error: "未提供 zip 文件" }, { status: 400 });
    }
    const lower = file.name.toLowerCase();
    if (!lower.endsWith(".zip")) {
      return NextResponse.json({ error: "仅支持 .zip 压缩包" }, { status: 400 });
    }
    if (file.size > MAX_ZIP_BYTES) {
      return NextResponse.json({ error: `压缩包过大(> ${MAX_ZIP_BYTES} 字节)` }, { status: 413 });
    }

    const buf = Buffer.from(await file.arrayBuffer());

    // 1. Read + sanitize entries (throws on traversal / bomb / too many).
    const entries = readZipEntries(buf);

    // 2. Locate SKILL.md + parse skill name.
    const parsed = parseSkillZip(entries);

    // 3. Resolve destination dir.
    const skillsRoot = isGlobal
      ? path.join(getAgentDir(), "skills")
      : path.join(cwd, ".pi", "agent", "skills");
    const safeName = sanitizeDirName(parsed.name);
    const destDir = path.join(skillsRoot, safeName);

    // 4. Conflict check — refuse to overwrite an existing skill.
    try {
      await fs.access(destDir);
      return NextResponse.json(
        { error: `已存在同名技能「${safeName}」(${destDir}),请先删除或重命名后重试` },
        { status: 409 },
      );
    } catch {
      // not present — proceed
    }

    // 5. Write entries, stripping the root prefix.
    await fs.mkdir(skillsRoot, { recursive: true });
    let written = 0;
    for (const e of entries) {
      const rel = parsed.rootPrefix && e.entryPath.startsWith(parsed.rootPrefix + "/")
        ? e.entryPath.slice(parsed.rootPrefix.length + 1)
        : e.entryPath;
      if (!rel || rel === parsed.rootPrefix) continue;
      const target = path.join(destDir, rel);
      // Defensive: final resolved path must remain under destDir.
      if (path.relative(destDir, target).startsWith("..")) {
        return NextResponse.json({ error: `解压路径越界:${rel}` }, { status: 400 });
      }
      if (e.isDirectory) {
        await fs.mkdir(target, { recursive: true });
      } else {
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, e.data);
        written++;
      }
    }

    return NextResponse.json({
      success: true,
      name: safeName,
      destDir,
      writtenFiles: written,
      scope: isGlobal ? "global" : "project",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// Make the folder name safe on both Windows and POSIX while keeping it
// readable. Mirrors uploads route sanitization but stricter on slashes.
function sanitizeDirName(raw: string): string {
  const base = raw.trim().replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/^\.+/, "");
  return base.slice(0, 120) || "skill";
}
