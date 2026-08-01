import { NextResponse } from "next/server";
import {
  SessionManager,
  createAgentSessionServices,
} from "@earendil-works/pi-coding-agent";
import { completeSimple, type AssistantMessage } from "@earendil-works/pi-ai/compat";
import { resolveSessionPath, buildSessionContext } from "@/lib/session-reader";

export const dynamic = "force-dynamic";

const SUMMARIZE_TIMEOUT_MS = 20_000;
const MAX_TITLE_LEN = 20;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getAssistantText(message: AssistantMessage): string {
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b): b is { type: string; text?: string } => isRecord(b) && b.type === "text")
    .map((b) => (typeof b.text === "string" ? b.text : ""))
    .join("\n");
}

/**
 * POST /api/agent/[id]/auto-name
 * Body: { provider: string, modelId: string }
 *
 * Generates a <=20-char summary title from the first user message + last
 * assistant reply of the session using completeSimple (no session pollution),
 * then writes it via appendSessionInfo. Silent on failure: returns
 * { renamed: false } instead of erroring so the UI never surfaces it.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const body = await req.json().catch(() => ({}));
    const provider = typeof body?.provider === "string" ? body.provider.trim() : "";
    const modelId = typeof body?.modelId === "string" ? body.modelId.trim() : "";
    if (!provider || !modelId) {
      return NextResponse.json({ renamed: false, reason: "no-model" });
    }

    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return NextResponse.json({ renamed: false, reason: "not-found" });
    }

    const sm = SessionManager.open(filePath);

    // Guard: never overwrite an existing name (manual or prior auto-name).
    const existingName = sm.getSessionName();
    if (existingName && existingName.trim()) {
      return NextResponse.json({ renamed: false, reason: "already-named" });
    }

    const entries = sm.getEntries() as never;
    const leafId = sm.getLeafId();
    const context = buildSessionContext(entries, leafId);
    const messages = context.messages ?? [];

    // Only the very first round: exactly one user message.
    const userMessages = messages.filter((m) => m.role === "user");
    if (userMessages.length !== 1) {
      return NextResponse.json({ renamed: false, reason: "not-first-round" });
    }

    // Last assistant reply (if any).
    const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
    if (!lastAssistant) {
      return NextResponse.json({ renamed: false, reason: "no-reply" });
    }

    const userText = extractText((userMessages[0] as { content: unknown }).content).slice(0, 2000);
    const replyText = extractText((lastAssistant as { content: unknown }).content).slice(0, 2000);
    if (!userText.trim()) {
      return NextResponse.json({ renamed: false, reason: "empty-user" });
    }

    // Build model registry from the session's cwd (falls back to process.cwd()).
    const cwd = sm.getHeader()?.cwd ?? process.cwd();
    const services = await createAgentSessionServices({ cwd });
    const registry = services.modelRegistry;
    const model = registry.find(provider, modelId);
    if (!model) {
      return NextResponse.json({ renamed: false, reason: "model-unavailable" });
    }

    const auth = await registry.getApiKeyAndHeaders(model);
    if (!auth.ok || !auth.apiKey) {
      return NextResponse.json({ renamed: false, reason: "no-api-key" });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SUMMARIZE_TIMEOUT_MS);

    let title = "";
    try {
      const message = await completeSimple(model, {
        messages: [{
          role: "user",
          content:
            `请根据以下对话，生成一个不超过${MAX_TITLE_LEN}个汉字/字符的简短会话标题，` +
            `要求准确概括用户的核心意图，不要加引号、标点或前缀，只输出标题文本本身。\n\n` +
            `用户消息：\n${userText}\n\n` +
            `助手回复：\n${replyText}`,
          timestamp: Date.now(),
        }],
      }, {
        apiKey: auth.apiKey,
        headers: auth.headers,
        maxTokens: 48,
        timeoutMs: SUMMARIZE_TIMEOUT_MS,
        maxRetries: 0,
        cacheRetention: "none",
        signal: controller.signal,
      });

      if (message.stopReason === "error" || message.stopReason === "aborted") {
        return NextResponse.json({ renamed: false, reason: "model-error" });
      }

      title = getAssistantText(message).trim();
    } finally {
      clearTimeout(timeout);
    }

    // Strip quotes / newlines, clamp length.
    title = title.replace(/^["“”'']+|["“”'']+$/g, "").replace(/\s+/g, " ").trim();
    if (!title) {
      return NextResponse.json({ renamed: false, reason: "empty-title" });
    }
    if (title.length > MAX_TITLE_LEN) {
      title = title.slice(0, MAX_TITLE_LEN);
    }

    // Re-check name right before writing (race: user may have renamed meanwhile).
    if (sm.getSessionName()?.trim()) {
      return NextResponse.json({ renamed: false, reason: "already-named" });
    }
    sm.appendSessionInfo(title);

    return NextResponse.json({ renamed: true, name: title });
  } catch (error) {
    // Silent failure — never surface to the user as an error toast.
    return NextResponse.json({ renamed: false, reason: "exception", error: errorMessage(error) });
  }
}
