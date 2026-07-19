"use client";

import React, { useRef, useState, useCallback, useEffect, useImperativeHandle, forwardRef, KeyboardEvent } from "react";
import type { BuiltinSlashCommandResult, CompactResultInfo, QueuedMessages, SlashCommandInfo } from "@/hooks/useAgentSession";
import { clearDraft, getDraft, setDraft } from "@/lib/draft-store";
import {
  buildEntriesFromFiles, buildAtInsertText, buildAtMentionText, extractAtQuery, filterFileEntries,
  type AtQueryMatch, type FileIndexEntry,
} from "@/lib/file-fuzzy";
import { FolderIcon, getFileIcon } from "./FileIcons";
import { useIsMobile } from "@/hooks/useIsMobile";
import type { SessionTreeNode } from "@/lib/types";

interface ModelOption {
  provider: string;
  modelId: string;
  name: string;
}

interface Props {
  onSend: (message: string) => void;
  onAbort: () => void;
  onSteer?: (message: string) => void;
  onFollowUp?: (message: string) => void;
  onPromptWithStreamingBehavior?: (message: string, behavior: "steer" | "followUp") => void;
  isStreaming: boolean;
  model?: { provider: string; modelId: string } | null;
  isAutoModelSelection?: boolean;
  modelNames?: Record<string, string>;
  modelList?: { id: string; name: string; provider: string }[];
  onModelChange?: (provider: string, modelId: string) => void;
  onCompact?: () => void;
  onAbortCompaction?: () => void;
  isCompacting?: boolean;
  compactError?: string | null;
  compactResult?: CompactResultInfo | null;
  toolPreset?: "none" | "default" | "full";
  onToolPresetChange?: (preset: "none" | "default" | "full") => void;
  thinkingLevel?: "auto" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  onThinkingLevelChange?: (level: "auto" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh") => void;
  availableThinkingLevels?: string[] | null;
  thinkingLevelMap?: Record<string, string | null> | null;
  retryInfo?: { attempt: number; maxAttempts: number; errorMessage?: string } | null;
  queuedMessages?: QueuedMessages | null;
  onRecallQueue?: () => void;
  slashCommands?: SlashCommandInfo[];
  slashCommandsLoading?: boolean;
  onLoadSlashCommands?: () => Promise<SlashCommandInfo[]> | SlashCommandInfo[];
  onBuiltinCommand?: (message: string) => Promise<BuiltinSlashCommandResult>;
  soundEnabled?: boolean;
  onSoundToggle?: () => void;
  onAudioUnlock?: () => void;
  draftKey?: string;
  /** Session working directory — enables the @ file autocomplete menu */
  cwd?: string | null;
  /** 打开「设置 → 技能」管理弹窗（由技能下拉底部「管理技能…」触发） */
  onManageSkills?: () => void;
  /** 打开会话信息顶部抽屉 */
  onOpenSessionInfo?: () => void;
  /** 打开系统提示词顶部抽屉 */
  onOpenSystemPrompt?: () => void;
  /** 分支树（底部「分支」按钮用） */
  branchTree?: SessionTreeNode[];
  /** 当前激活的分支叶节点 id */
  branchActiveLeafId?: string | null;
  /** 切换到指定分支叶节点 */
  onBranchLeafChange?: (leafId: string | null) => void;
  /** 打开/关闭「分支」顶部抽屉 */
  onToggleBranchPanel?: () => void;
}

export interface ChatInputHandle {
  insertText: (text: string) => void;
  insertIfEmpty: (text: string) => void;
  prependText: (text: string) => void;
  addFiles: (files: File[]) => void;
}

const TOOL_PRESETS = ["off", "default", "full"] as const;
const TOOL_PRESET_MAP: Record<"off" | "default" | "full", "none" | "default" | "full"> = { off: "none", default: "default", full: "full" };
const COMPOSITION_END_ENTER_GRACE_MS = 100;
const MODEL_OPTION_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function compareModelOptions(a: ModelOption, b: ModelOption): number {
  return MODEL_OPTION_COLLATOR.compare(a.name || a.modelId, b.name || b.modelId)
    || MODEL_OPTION_COLLATOR.compare(a.provider, b.provider)
    || MODEL_OPTION_COLLATOR.compare(a.modelId, b.modelId);
}

const THINKING_LEVELS = ["auto", "off", "minimal", "low", "medium", "high", "xhigh"] as const;
const THINKING_LEVEL_DESC: Record<typeof THINKING_LEVELS[number], string> = {
  auto: "使用 pi 默认",
  off: "关闭推理",
  minimal: "最低推理",
  low: "低推理",
  medium: "中等推理",
  high: "高推理",
  xhigh: "最高推理",
};

function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return tokens.toLocaleString();
}

type SlashCommandPaletteItem = SlashCommandInfo | {
  name: string;
  description: string;
  source: "builtin";
};

type SlashCommandSource = SlashCommandPaletteItem["source"];

const BUILTIN_SLASH_COMMANDS: SlashCommandPaletteItem[] = [
  { name: "compact", description: "压缩上下文，可附带说明", source: "builtin" },
  { name: "reload", description: "重新加载扩展、技能、提示词和工具", source: "builtin" },
  { name: "name", description: "设置会话显示名", source: "builtin" },
  { name: "session", description: "显示会话消息、token 和费用统计", source: "builtin" },
  { name: "copy", description: "复制最后一条助手消息", source: "builtin" },
];

const SLASH_SOURCES: SlashCommandSource[] = ["builtin", "extension", "prompt", "skill"];

const SLASH_SOURCE_GROUP_LABEL: Record<SlashCommandSource, string> = {
  builtin: "内置",
  extension: "扩展",
  prompt: "提示词",
  skill: "技能",
};

const SLASH_SOURCE_ORDER: Record<SlashCommandSource, number> = {
  builtin: 0,
  extension: 1,
  prompt: 2,
  skill: 3,
};

function slashMatchRank(command: SlashCommandPaletteItem, query: string): number {
  const name = command.name.toLowerCase();
  const description = command.description?.toLowerCase() ?? "";
  if (name === query) return 0;
  if (name.startsWith(query)) return 1;
  if (name.includes(query)) return 2;
  if (description.includes(query)) return 3;
  return 4;
}

function QueuedMessageRow({ kind, text }: { kind: "steer" | "follow-up"; text: string }) {
  return (
    <div
      title={text}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "3px 10px",
        fontSize: 12,
        color: "var(--text-muted)",
        minWidth: 0,
      }}
    >
      <span
        style={{
          flexShrink: 0,
          fontSize: 10,
          fontFamily: "var(--font-mono)",
          padding: "1px 7px",
          borderRadius: 999,
          border: `1px solid ${kind === "steer" ? "color-mix(in srgb, var(--accent) 45%, transparent)" : "var(--border)"}`,
          color: kind === "steer" ? "var(--accent)" : "var(--text-dim)",
        }}
      >
        {kind === "steer" ? "转向" : "追问"}
      </span>
      <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{text}</span>
    </div>
  );
}

export const ChatInput = forwardRef<ChatInputHandle, Props>(function ChatInput({
  onSend, onAbort, onSteer, onFollowUp, isStreaming, model, isAutoModelSelection, modelNames, modelList, onModelChange,
  onCompact, onAbortCompaction, isCompacting, compactError, compactResult, toolPreset, onToolPresetChange,
  thinkingLevel, onThinkingLevelChange, availableThinkingLevels, thinkingLevelMap,
  retryInfo, queuedMessages, onRecallQueue,
  slashCommands, slashCommandsLoading, onLoadSlashCommands,
  onBuiltinCommand,
  soundEnabled, onSoundToggle, onAudioUnlock,
  onPromptWithStreamingBehavior,
  draftKey,
  cwd,
  onManageSkills,
  onOpenSessionInfo,
  onOpenSystemPrompt,
  branchTree,
  branchActiveLeafId,
  onBranchLeafChange,
  onToggleBranchPanel,
}: Props, ref) {
  const isMobile = useIsMobile();
  const [value, setValue] = useState(() => (draftKey ? getDraft(draftKey)?.value ?? "" : ""));
  const [modelDropdownOpen, setModelDropdownOpen] = useState(false);
  const [modelDropdownRect, setModelDropdownRect] = useState<{ top: number; left: number; width: number } | null>(null);
  const [toolDropdownOpen, setToolDropdownOpen] = useState(false);
  const [thinkingDropdownOpen, setThinkingDropdownOpen] = useState(false);
  const [skillsDropdownOpen, setSkillsDropdownOpen] = useState(false);
  const [skillsDropdownRect, setSkillsDropdownRect] = useState<{ top: number; left: number; width: number } | null>(null);
  const [skillsList, setSkillsList] = useState<{ name: string }[] | null>(null);
  const [skillsLoading, setSkillsLoading] = useState(false);
  const [controlsMenuOpen, setControlsMenuOpen] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [slashMenuOpen, setSlashMenuOpen] = useState(false);
  const [slashActiveIndex, setSlashActiveIndex] = useState(0);
  const [atQuery, setAtQuery] = useState<AtQueryMatch | null>(null);
  const [atMenuOpen, setAtMenuOpen] = useState(false);
  const [atActiveIndex, setAtActiveIndex] = useState(0);
  const [fileIndex, setFileIndex] = useState<{ cwd: string; entries: FileIndexEntry[]; truncated: boolean } | null>(null);
  const [fileIndexLoading, setFileIndexLoading] = useState(false);
  const [atServerResult, setAtServerResult] = useState<{ cwd: string; query: string; matches: FileIndexEntry[] } | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const inputBoxRef = useRef<HTMLDivElement>(null);
  // Popups (slash / @) use position:fixed to escape ancestor overflow clipping
  // (e.g. the welcome screen clips the upward pop-up behind the top bar).
  // We measure the input box rect and place the popup just above it.
  const [popupRect, setPopupRect] = useState<{ left: number; width: number; bottom: number; maxH: number } | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const modelDropdownPanelRef = useRef<HTMLDivElement>(null);
  const toolDropdownRef = useRef<HTMLDivElement>(null);
  const thinkingDropdownRef = useRef<HTMLDivElement>(null);
  const skillsDropdownPanelRef = useRef<HTMLDivElement>(null);
  const skillsTriggerRef = useRef<HTMLButtonElement>(null);
  const controlsMenuRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const isComposingRef = useRef(false);
  const lastCompositionEndAtRef = useRef(0);
  const slashCommandsRequestedRef = useRef(false);
  const slashItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const atItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const fileIndexMetaRef = useRef<{ cwd: string; fetchedAt: number } | null>(null);
  const fileIndexFetchingRef = useRef<string | null>(null);
  const draftKeyRef = useRef(draftKey);
  const valueRef = useRef(value);
  valueRef.current = value;

  const insertTextAtCursor = useCallback((text: string) => {
    const ta = textareaRef.current;
    if (!ta) {
      setValue((v) => v + (v ? " " : "") + text);
      return;
    }
    const start = ta.selectionStart ?? ta.value.length;
    const end = ta.selectionEnd ?? ta.value.length;
    const before = ta.value.slice(0, start);
    const after = ta.value.slice(end);
    const sep = before.length > 0 && !before.endsWith(" ") ? " " : "";
    const newVal = before + sep + text + after;
    setValue(newVal);
    setAtQuery(null);
    requestAnimationFrame(() => {
      if (!ta) return;
      const pos = start + sep.length + text.length;
      ta.setSelectionRange(pos, pos);
      ta.focus();
      ta.style.height = "auto";
      ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
    });
  }, []);

  // Measure the input box so the slash / @ popups can be positioned with
  // position:fixed (escaping overflow clipping) just above it. Recompute on
  // viewport resize; remeasure right before each open via measurePopup().
  const measurePopup = useCallback(() => {
    const el = inputBoxRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const vh = window.visualViewport?.height ?? window.innerHeight;
    // Leave 8px gap above the input; cap height so the popup never underflows
    // the top bar (top edge clamped to >= 8px from viewport top).
    const maxH = Math.max(120, Math.min(rect.top - 8 - 8, Math.round(vh * 0.56), 460));
    setPopupRect({ left: rect.left, width: rect.width, bottom: vh - rect.top + 8, maxH });
  }, []);

  // Measure whenever a popup opens, and keep it in sync on viewport resize.
  useEffect(() => {
    if (!slashMenuOpen && !atMenuOpen) return;
    measurePopup();
    const onResize = () => measurePopup();
    window.addEventListener("resize", onResize);
    window.visualViewport?.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      window.visualViewport?.removeEventListener("resize", onResize);
    };
  }, [slashMenuOpen, atMenuOpen, measurePopup]);

  useImperativeHandle(ref, () => ({
    insertIfEmpty(text: string) {
      const ta = textareaRef.current;
      const current = ta ? ta.value : value;
      if (current.trim()) return;
      setValue(text);
      setAtQuery(null);
      requestAnimationFrame(() => {
        if (!ta) return;
        ta.focus();
        ta.style.height = "auto";
        ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
      });
    },
    prependText(text: string) {
      if (!text.trim()) return;
      const ta = textareaRef.current;
      const current = ta ? ta.value : value;
      // Mirrors the TUI's queue restore: queued text first, then whatever
      // the user already typed, separated by a blank line.
      const combined = [text, current].filter((t) => t.trim()).join("\n\n");
      setValue(combined);
      setAtQuery(null);
      requestAnimationFrame(() => {
        if (!ta) return;
        ta.focus();
        ta.setSelectionRange(combined.length, combined.length);
        ta.style.height = "auto";
        ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
      });
    },
    insertText(text: string) {
      insertTextAtCursor(text);
    },
    addFiles(files: File[]) {
      processFiles(files);
    },
  }));

  const processFiles = useCallback(async (files: File[]) => {
    if (isStreaming) return;
    if (!cwd) return;
    if (!files.length) return;
    setIsUploading(true);
    setUploadError(null);
    try {
      const form = new FormData();
      form.set("cwd", cwd);
      for (const f of files) form.append("file", f);
      const res = await fetch("/api/uploads", { method: "POST", body: form });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setUploadError((err as { error?: string }).error ?? `上传失败 (${res.status})`);
        return;
      }
      const data = (await res.json()) as { paths: string[] };
      if (data.paths.length) {
        // Insert all mentions in ONE call. Calling insertTextAtCursor per path
        // in a loop loses all but the last: each call reads the textarea's
        // (still-stale) value before React's async setValue flushes to the DOM,
        // so each path overwrites the previous one. Build a single text blob.
        const mentions = data.paths.map((p) => buildAtMentionText(p, false)).join("");
        insertTextAtCursor(mentions);
      }
    } finally {
      setIsUploading(false);
    }
  }, [isStreaming, cwd, insertTextAtCursor]);

  const clearInput = useCallback(() => {
    setValue("");
    setAtQuery(null);
    setUploadError(null);
    if (draftKey) clearDraft(draftKey);
    if (draftKeyRef.current && draftKeyRef.current !== draftKey) clearDraft(draftKeyRef.current);
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  }, [draftKey]);

  useEffect(() => {
    if (!draftKey || draftKeyRef.current !== draftKey) return;
    setDraft(draftKey, {
      value,
      images: [],
    });
  }, [draftKey, value]);

  useEffect(() => {
    const previousDraftKey = draftKeyRef.current;
    if (previousDraftKey === draftKey) return;

    if (previousDraftKey) {
      setDraft(previousDraftKey, {
        value: valueRef.current,
        images: [],
      });
    }

    const draft = draftKey ? getDraft(draftKey) : null;
    draftKeyRef.current = draftKey;
    setValue(draft?.value ?? "");
    setAtQuery(null);
  }, [draftKey]);

  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    if (value) ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
  }, [value]);

  useEffect(() => {
    if (uploadError) {
      const t = setTimeout(() => setUploadError(null), 5000);
      return () => clearTimeout(t);
    }
  }, [uploadError]);

  const handleSend = useCallback(async () => {
    const msg = value.trim();
    if (!msg) return;
    if (isStreaming) return;
    onAudioUnlock?.();
    if (msg.startsWith("/") && onBuiltinCommand) {
      const result = await onBuiltinCommand(msg);
      if (result.handled) {
        if (!result.error) clearInput();
        return;
      }
    }
    onSend(msg);
    clearInput();
  }, [value, isStreaming, onBuiltinCommand, onSend, clearInput, onAudioUnlock]);

  const slashQuery = value.startsWith("/") && !/\s/.test(value.slice(1))
    ? value.slice(1).toLowerCase()
    : null;

  const filteredSlashCommands = (() => {
    if (slashQuery === null) return [];
    const commands = [...(isStreaming ? [] : BUILTIN_SLASH_COMMANDS), ...(slashCommands ?? [])];
    return [...commands]
      .filter((command) => {
        const name = command.name.toLowerCase();
        const description = command.description?.toLowerCase() ?? "";
        return name.includes(slashQuery) || description.includes(slashQuery);
      })
      .sort((a, b) => {
        const rankDelta = slashMatchRank(a, slashQuery) - slashMatchRank(b, slashQuery);
        if (rankDelta !== 0) return rankDelta;
        return SLASH_SOURCE_ORDER[a.source] - SLASH_SOURCE_ORDER[b.source]
          || MODEL_OPTION_COLLATOR.compare(a.name, b.name);
      });
  })();

  const groupedSlashCommands = (() => {
    const groups = new Map<SlashCommandSource, { source: SlashCommandSource; items: { command: SlashCommandPaletteItem; index: number }[] }>();
    for (const source of SLASH_SOURCES) {
      groups.set(source, { source, items: [] });
    }
    filteredSlashCommands.forEach((command, index) => {
      groups.get(command.source)?.items.push({ command, index });
    });
    return SLASH_SOURCES
      .map((source) => groups.get(source)!)
      .filter((group) => group.items.length > 0);
  })();

  const slashCommandCountLabel = filteredSlashCommands.length === 1
    ? (slashQuery ? "1 个匹配" : "1 个命令")
    : `${filteredSlashCommands.length} ${slashQuery ? "个匹配" : "个命令"}`;
  const hasInputText = Boolean(value.trim());
  const canQueueStreamingMessage = hasInputText;

  // ── @ file autocomplete ──────────────────────────────────────────────────
  // Recomputed from the text before the caret on every change/caret move.
  // Disabled entirely when there is no cwd (new session without a directory).
  const updateAtQuery = useCallback((text: string, cursor: number | null) => {
    if (!cwd) {
      setAtQuery(null);
      return;
    }
    const pos = cursor ?? text.length;
    setAtQuery(extractAtQuery(text.slice(0, pos)));
  }, [cwd]);

  const atQueryText = atQuery?.query ?? null;
  const atLocalMatches: FileIndexEntry[] = React.useMemo(() => (
    atQueryText !== null && fileIndex && fileIndex.cwd === cwd
      ? filterFileEntries(fileIndex.entries, atQueryText)
      : []
  ), [atQueryText, fileIndex, cwd]);

  // When the client index is truncated (repo larger than the index cap),
  // local filtering cannot see deep files, so queries are also ranked
  // server-side against the full listing. Local matches render immediately
  // and are replaced when the (debounced) server result for the current
  // query arrives; stale responses are ignored via the query/cwd tag.
  const needsServerSearch = Boolean(atQueryText && fileIndex?.truncated && fileIndex.cwd === cwd);
  useEffect(() => {
    if (!needsServerSearch || !cwd || !atQueryText) return;
    const fetchCwd = cwd;
    const query = atQueryText;
    const timer = setTimeout(() => {
      fetch(`/api/file-index?cwd=${encodeURIComponent(fetchCwd)}&q=${encodeURIComponent(query)}`)
        .then((res) => {
          if (!res.ok) throw new Error(`file search failed: ${res.status}`);
          return res.json() as Promise<{ matches?: FileIndexEntry[] }>;
        })
        .then((data) => setAtServerResult({ cwd: fetchCwd, query, matches: data.matches ?? [] }))
        .catch(() => {
          // Keep showing local matches; the next keystroke retries.
        });
    }, 150);
    return () => clearTimeout(timer);
  }, [needsServerSearch, atQueryText, cwd]);

  const serverResultInUse = needsServerSearch
    && atServerResult !== null
    && atServerResult.cwd === cwd
    && atServerResult.query === atQueryText;
  const atMatches: FileIndexEntry[] = serverResultInUse ? atServerResult.matches : atLocalMatches;

  // Open/reset the menu whenever the @token appears or changes (mirrors the
  // slash menu: Escape closes it, the next keystroke re-opens it).
  const atTokenKey = atQuery === null ? null : `${atQuery.start}:${atQuery.quoted ? 1 : 0}:${atQuery.query}`;
  useEffect(() => {
    if (atTokenKey === null) {
      setAtMenuOpen(false);
      setAtActiveIndex(0);
      return;
    }
    setAtMenuOpen(true);
    setAtActiveIndex(0);
  }, [atTokenKey]);

  // Fetch the file index when the menu opens. The server caches per cwd for
  // ~10s, so re-opening refreshes cheaply; while typing nothing refetches.
  const atTokenActive = atQuery !== null;
  useEffect(() => {
    if (!atTokenActive || !cwd) return;
    const meta = fileIndexMetaRef.current;
    if (meta && meta.cwd === cwd && Date.now() - meta.fetchedAt < 10_000) return;
    if (fileIndexFetchingRef.current === cwd) return;
    fileIndexFetchingRef.current = cwd;
    const fetchCwd = cwd;
    setFileIndexLoading(true);
    fetch(`/api/file-index?cwd=${encodeURIComponent(fetchCwd)}`)
      .then((res) => {
        if (!res.ok) throw new Error(`file index failed: ${res.status}`);
        return res.json() as Promise<{ files?: string[]; truncated?: boolean }>;
      })
      .then((data) => {
        setFileIndex({ cwd: fetchCwd, entries: buildEntriesFromFiles(data.files ?? []), truncated: !!data.truncated });
        fileIndexMetaRef.current = { cwd: fetchCwd, fetchedAt: Date.now() };
      })
      .catch(() => {
        // Leave any previous index in place; next open retries.
        fileIndexMetaRef.current = null;
      })
      .finally(() => {
        fileIndexFetchingRef.current = null;
        setFileIndexLoading(false);
      });
  }, [atTokenActive, cwd]);

  const applyAtCompletion = useCallback((entry: FileIndexEntry) => {
    if (!atQuery) return;
    const ta = textareaRef.current;
    const cursor = ta?.selectionStart ?? value.length;
    const before = value.slice(0, atQuery.start);
    let after = value.slice(cursor);
    // Completing inside a quoted token (@"my dir/… with the caret before the
    // closing quote): the replacement carries its own closing quote, so drop
    // the old one right after the caret (mirrors the TUI's applyCompletion).
    if (atQuery.quoted && after.startsWith('"')) {
      after = after.slice(1);
    }
    const insert = buildAtInsertText(entry.path, entry.isDir, atQuery.quoted);
    const newValue = before + insert.text + after;
    const newPos = before.length + insert.cursorOffset;
    setValue(newValue);
    // setValue alone does not fire onChange — re-derive the token here. Files
    // end with a space (token closes, menu hides); directories end with "/"
    // before the caret (token stays open for drill-down into the directory).
    setAtQuery(extractAtQuery(newValue.slice(0, newPos)));
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(newPos, newPos);
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
    });
  }, [atQuery, value]);

  useEffect(() => {
    if (atActiveIndex >= atMatches.length) {
      setAtActiveIndex(Math.max(0, atMatches.length - 1));
    }
  }, [atMatches.length, atActiveIndex]);

  useEffect(() => {
    atItemRefs.current.length = atMatches.length;
  }, [atMatches.length]);

  useEffect(() => {
    if (!atMenuOpen) return;
    atItemRefs.current[atActiveIndex]?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [atActiveIndex, atMenuOpen]);

  const applySlashCommand = useCallback((command: SlashCommandPaletteItem) => {
    const nextValue = `/${command.name} `;
    setValue(nextValue);
    setSlashMenuOpen(false);
    setSlashActiveIndex(0);
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(nextValue.length, nextValue.length);
      ta.style.height = "auto";
      ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
    });
  }, []);

  const sendQueued = useCallback((mode: "steer" | "followup") => {
    const msg = value.trim();
    if (!msg) return;
    onAudioUnlock?.();
    const streamingBehavior = mode === "steer" ? "steer" : "followUp";
    if (msg.startsWith("/") && onPromptWithStreamingBehavior) {
      onPromptWithStreamingBehavior(msg, streamingBehavior);
      clearInput();
      return;
    }
    if (mode === "steer" && onSteer) {
      onSteer(msg);
    } else if (mode === "followup" && onFollowUp) {
      onFollowUp(msg);
    }
    clearInput();
  }, [value, onPromptWithStreamingBehavior, onSteer, onFollowUp, clearInput, onAudioUnlock]);

  const getNextSlashIndex = useCallback((direction: "up" | "down" | "left" | "right") => {
    const lastIndex = filteredSlashCommands.length - 1;
    if (lastIndex < 0) return 0;

    if (direction === "left") return Math.max(0, slashActiveIndex - 1);
    if (direction === "right") return Math.min(lastIndex, slashActiveIndex + 1);

    const currentNode = slashItemRefs.current[slashActiveIndex];
    if (!currentNode) {
      return direction === "down"
        ? Math.min(lastIndex, slashActiveIndex + 1)
        : Math.max(0, slashActiveIndex - 1);
    }

    const currentRect = currentNode.getBoundingClientRect();
    const currentX = currentRect.left + currentRect.width / 2;
    const currentY = currentRect.top + currentRect.height / 2;
    let bestIndex = -1;
    let bestScore = Number.POSITIVE_INFINITY;

    for (let index = 0; index <= lastIndex; index += 1) {
      if (index === slashActiveIndex) continue;
      const node = slashItemRefs.current[index];
      if (!node) continue;
      const rect = node.getBoundingClientRect();
      const candidateY = rect.top + rect.height / 2;
      const verticalDelta = candidateY - currentY;
      if (direction === "down" ? verticalDelta <= 4 : verticalDelta >= -4) continue;

      const candidateX = rect.left + rect.width / 2;
      const score = Math.abs(verticalDelta) * 1000 + Math.abs(candidateX - currentX);
      if (score < bestScore) {
        bestIndex = index;
        bestScore = score;
      }
    }

    if (bestIndex >= 0) return bestIndex;
    return direction === "down"
      ? Math.min(lastIndex, slashActiveIndex + 1)
      : Math.max(0, slashActiveIndex - 1);
  }, [filteredSlashCommands.length, slashActiveIndex]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      const nativeEvent = e.nativeEvent;
      const recentlyComposed = Date.now() - lastCompositionEndAtRef.current < COMPOSITION_END_ENTER_GRACE_MS;
      const isComposing =
        isComposingRef.current ||
        nativeEvent.isComposing ||
        nativeEvent.keyCode === 229;

      if (e.key === "Enter" && !e.shiftKey && (isComposing || recentlyComposed)) {
        if (recentlyComposed) e.preventDefault();
        return;
      }

      if (slashMenuOpen && slashQuery !== null) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setSlashActiveIndex(getNextSlashIndex("down"));
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setSlashActiveIndex(getNextSlashIndex("up"));
          return;
        }
        if (e.key === "ArrowRight") {
          e.preventDefault();
          setSlashActiveIndex(getNextSlashIndex("right"));
          return;
        }
        if (e.key === "ArrowLeft") {
          e.preventDefault();
          setSlashActiveIndex(getNextSlashIndex("left"));
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setSlashMenuOpen(false);
          return;
        }
        if ((e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) && filteredSlashCommands[slashActiveIndex]) {
          e.preventDefault();
          applySlashCommand(filteredSlashCommands[slashActiveIndex]);
          return;
        }
      }

      // @ file menu — skip while composing so IME candidate navigation
      // (arrows/Enter/Tab) is never intercepted.
      if (atMenuOpen && atQuery !== null && !isComposing) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setAtActiveIndex((i) => Math.min(Math.max(0, atMatches.length - 1), i + 1));
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setAtActiveIndex((i) => Math.max(0, i - 1));
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setAtMenuOpen(false);
          return;
        }
        if ((e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) && atMatches[atActiveIndex]) {
          e.preventDefault();
          applyAtCompletion(atMatches[atActiveIndex]);
          return;
        }
      }

      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if (isStreaming && (onSteer || onFollowUp)) {
          // Default Enter sends as steer if available, else followup
          sendQueued(onSteer ? "steer" : "followup");
        } else {
          handleSend();
        }
      }
    },
    [isStreaming, onSteer, onFollowUp, slashMenuOpen, slashQuery, filteredSlashCommands, slashActiveIndex, applySlashCommand, sendQueued, handleSend, getNextSlashIndex, atMenuOpen, atQuery, atMatches, atActiveIndex, applyAtCompletion]
  );

  const handleInput = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
  }, []);

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = Array.from(e.clipboardData?.items ?? []);
    const fileItems = items.filter((item) => item.kind === "file");
    if (!fileItems.length) return;
    e.preventDefault();
    const files = fileItems.map((item) => item.getAsFile()).filter((f): f is File => f !== null);
    processFiles(files);
  }, [processFiles]);

  useEffect(() => {
    if (slashQuery === null) {
      setSlashMenuOpen(false);
      setSlashActiveIndex(0);
      slashCommandsRequestedRef.current = false;
      return;
    }
    setSlashMenuOpen(true);
    setSlashActiveIndex(0);
    if (!slashCommandsRequestedRef.current && onLoadSlashCommands) {
      slashCommandsRequestedRef.current = true;
      Promise.resolve(onLoadSlashCommands()).catch(() => {
        slashCommandsRequestedRef.current = false;
      });
    }
  }, [slashQuery, onLoadSlashCommands]);

  useEffect(() => {
    if (slashActiveIndex >= filteredSlashCommands.length) {
      setSlashActiveIndex(Math.max(0, filteredSlashCommands.length - 1));
    }
  }, [filteredSlashCommands.length, slashActiveIndex]);

  useEffect(() => {
    slashItemRefs.current.length = filteredSlashCommands.length;
  }, [filteredSlashCommands.length]);

  useEffect(() => {
    if (!slashMenuOpen) return;
    slashItemRefs.current[slashActiveIndex]?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [slashActiveIndex, slashMenuOpen]);

  // Build model options: prefer modelList (has provider info), fallback to modelNames
  const modelOptions: ModelOption[] = (() => {
    if (modelList && modelList.length > 0) {
      return modelList.map((m) => ({ provider: m.provider, modelId: m.id, name: m.name })).sort(compareModelOptions);
    }
    return Object.entries(modelNames ?? {}).map(([modelId, name]) => ({
      provider: model?.provider ?? "unknown",
      modelId,
      name,
    })).sort(compareModelOptions);
  })();

  // Group options by provider, preserving insertion order
  const modelsByProvider: { provider: string; options: ModelOption[] }[] = [];
  for (const opt of modelOptions) {
    const group = modelsByProvider.find((g) => g.provider === opt.provider);
    if (group) group.options.push(opt);
    else modelsByProvider.push({ provider: opt.provider, options: [opt] });
  }

  const displayModelName = model
    ? (modelOptions.find((o) => o.modelId === model.modelId && o.provider === model.provider)?.name ?? model.modelId)
    : null;
  const currentName = displayModelName;

  const compactSavedTokens = compactResult
    ? Math.max(0, compactResult.tokensBefore - compactResult.estimatedTokensAfter)
    : 0;
  const compactReasonLabel: Record<string, string> = {
    auto: "自动",
    manual: "手动",
  };
  const compactVerb = compactResult?.reason && compactResult.reason !== "manual"
    ? `${compactReasonLabel[compactResult.reason] ?? compactResult.reason}压缩`
    : "已压缩";
  const compactResultText = compactResult
    ? `${compactVerb} ${formatTokenCount(compactResult.tokensBefore)} -> ${formatTokenCount(compactResult.estimatedTokensAfter)} token（节省 ${formatTokenCount(compactSavedTokens)}）`
    : null;
  const thinkingDisplayLabel = (() => {
    const lvl = thinkingLevel ?? "auto";
    if (lvl === "auto" || !thinkingLevelMap) return lvl;
    return thinkingLevelMap[lvl] ?? lvl;
  })();
  const toolPresetLabel = Object.entries(TOOL_PRESET_MAP).find(([, v]) => v === (toolPreset ?? "default"))?.[0] ?? "default";

  const enabledSkills = (skillsList ?? []).slice().sort((a, b) => MODEL_OPTION_COLLATOR.compare(a.name, b.name));

  // Fetch enabled skills whenever the skills dropdown opens (re-fetched each open,
  // so toggling a skill in the manager is reflected next time the dropdown opens).
  useEffect(() => {
    if (!skillsDropdownOpen || !cwd) return;
    setSkillsLoading(true);
    let cancelled = false;
    fetch(`/api/skills?cwd=${encodeURIComponent(cwd)}`)
      .then((r) => (r.ok ? r.json() as Promise<{ skills?: { name: string; disableModelInvocation?: boolean }[] }> : null))
      .then((d) => {
        if (cancelled) return;
        const list = (d?.skills ?? [])
          .filter((s) => s.name && !s.disableModelInvocation)
          .map((s) => ({ name: s.name }));
        setSkillsList(list);
      })
      .catch(() => { /* ignore */ })
      .finally(() => { if (!cancelled) setSkillsLoading(false); });
    return () => { cancelled = true; };
  }, [skillsDropdownOpen, cwd]);

  const applySkill = useCallback((name: string) => {
    setSkillsDropdownOpen(false);
    // 与 / 斜杠命令一致：技能发送为 /skill:<名字>（见 lib/rpc-manager.ts 的 skill:name 命名）
    insertTextAtCursor(`/skill:${name} `);
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [insertTextAtCursor]);

  // Close dropdowns on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (
        dropdownRef.current && !dropdownRef.current.contains(e.target as Node) &&
        modelDropdownPanelRef.current && !modelDropdownPanelRef.current.contains(e.target as Node)
      ) {
        setModelDropdownOpen(false);
      }
      if (toolDropdownRef.current && !toolDropdownRef.current.contains(e.target as Node)) {
        setToolDropdownOpen(false);
      }
      if (thinkingDropdownRef.current && !thinkingDropdownRef.current.contains(e.target as Node)) {
        setThinkingDropdownOpen(false);
      }
      // Skills dropdown is position:fixed (detached from trigger), so also
      // ignore clicks on the trigger button itself.
      if (
        skillsTriggerRef.current && !skillsTriggerRef.current.contains(e.target as Node) &&
        skillsDropdownPanelRef.current && !skillsDropdownPanelRef.current.contains(e.target as Node)
      ) {
        setSkillsDropdownOpen(false);
      }
      if (controlsMenuRef.current && !controlsMenuRef.current.contains(e.target as Node)) {
        setControlsMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  useEffect(() => {
    if (!isMobile) setControlsMenuOpen(false);
  }, [isMobile]);



  return (
    <div
      style={{
        flexShrink: 0,
        background: "transparent",
        padding: "0 16px 8px",
        paddingRight: isMobile ? 16 : 52, // desktop: 16px base + 36px for ChatMinimap alignment
      }}
    >
      {/* Hidden file input — accepts any file format */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        disabled={isStreaming || !cwd}
        style={{ display: "none" }}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          processFiles(files);
          e.target.value = "";
        }}
      />
      <div style={{ maxWidth: 820, margin: "0 auto" }}>
        {/* Queued steering / follow-up messages (delivered by pi on upcoming turns) */}
        {((queuedMessages?.steering.length ?? 0) + (queuedMessages?.followUp.length ?? 0)) > 0 && (
          <div style={{
            marginBottom: 8,
            border: "1px solid var(--border)",
            borderRadius: 6,
            background: "var(--bg-panel)",
            padding: "5px 0",
          }}>
            <div style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
              padding: "2px 8px 4px 10px",
            }}>
              <span style={{
                fontSize: 10,
                fontFamily: "var(--font-mono)",
                color: "var(--text-dim)",
                textTransform: "uppercase",
                letterSpacing: 0.4,
              }}>
                已排队 · {(queuedMessages?.steering.length ?? 0) + (queuedMessages?.followUp.length ?? 0)}
              </span>
              {onRecallQueue && (
                <button
                  onClick={onRecallQueue}
                  title="移除所有排队消息并放回输入框以便编辑"
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "4px 12px",
                    fontSize: 12,
                    color: "var(--text)",
                    background: "transparent",
                    border: "1px solid var(--border)",
                    borderRadius: 7,
                    cursor: "pointer",
                    transition: "background 0.12s, border-color 0.12s",
                    whiteSpace: "nowrap",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = "var(--bg-hover)";
                    e.currentTarget.style.borderColor = "color-mix(in srgb, var(--accent) 45%, var(--border))";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = "transparent";
                    e.currentTarget.style.borderColor = "var(--border)";
                  }}
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="9 14 4 9 9 4" />
                    <path d="M20 20v-7a4 4 0 0 0-4-4H4" />
                  </svg>
                  放回输入框
                </button>
              )}
            </div>
            {queuedMessages?.steering.map((text, i) => (
              <QueuedMessageRow key={`steer-${i}`} kind="steer" text={text} />
            ))}
            {queuedMessages?.followUp.map((text, i) => (
              <QueuedMessageRow key={`followup-${i}`} kind="follow-up" text={text} />
            ))}
          </div>
        )}
        {/* Retry banner */}
        {retryInfo && (
          <div style={{
            marginBottom: 8, padding: "5px 10px",
            background: "rgba(234,179,8,0.08)", border: "1px solid rgba(234,179,8,0.25)",
            borderRadius: 6, fontSize: 12, color: "rgba(180,130,0,0.9)",
            display: "flex", alignItems: "center", gap: 6,
          }}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
              <path d="M3 3v5h5" />
            </svg>
            正在重试（{retryInfo.attempt}/{retryInfo.maxAttempts}）…{retryInfo.errorMessage && <span style={{ opacity: 0.7, marginLeft: 4 }}>— {retryInfo.errorMessage}</span>}
          </div>
        )}
        {compactResultText && (
          <div style={{
            marginBottom: 8, padding: "5px 10px",
            background: "rgba(16,185,129,0.08)", border: "1px solid rgba(16,185,129,0.24)",
            borderRadius: 6, fontSize: 12, color: "rgba(5,150,105,0.95)",
            display: "flex", alignItems: "center", gap: 6,
          }}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <polyline points="20 6 9 17 4 12" />
            </svg>
            {compactResultText}
          </div>
        )}
        {/* Upload error banner */}
        {uploadError && (
          <div style={{
            marginBottom: 8, padding: "5px 10px",
            background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.25)",
            borderRadius: 6, fontSize: 12, color: "#ef4444",
            display: "flex", alignItems: "center", gap: 6,
          }}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
            {uploadError}
          </div>
        )}

        {/* Main input */}
        <div ref={inputBoxRef} style={{ position: "relative" }}>
          {slashMenuOpen && slashQuery !== null && popupRect && (
            <div
              style={{
                position: "fixed",
                left: popupRect.left,
                width: popupRect.width,
                bottom: popupRect.bottom,
                zIndex: 1000,
                background: "var(--bg)",
                border: "1px solid var(--border)",
                borderRadius: 8,
                boxShadow: "0 -6px 20px rgba(0,0,0,0.12)",
                overflow: "hidden",
                maxHeight: popupRect.maxH,
              }}
            >
              <div
                style={{
                  padding: "8px 10px",
                  borderBottom: "1px solid var(--border)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 8,
                  fontSize: 11,
                  color: "var(--text-dim)",
                }}
              >
                <span>{slashCommandsLoading ? "正在加载命令..." : `斜杠命令 · ${slashCommandCountLabel}`}</span>
                <span style={{ fontFamily: "var(--font-mono)" }}>Tab / Enter</span>
              </div>
              <div style={{ maxHeight: popupRect.maxH - 34, overflowY: "auto", padding: 10 }}>
                {!slashCommandsLoading && filteredSlashCommands.length === 0 ? (
                  <div style={{ padding: "2px 2px 4px", fontSize: 12, color: "var(--text-dim)" }}>
                    未找到扩展、提示词或技能命令
                  </div>
                ) : (
                  groupedSlashCommands.map((group) => (
                    <section key={group.source} style={{ marginBottom: 12 }}>
                      <div
                        style={{
                          position: "sticky",
                          top: -10,
                          zIndex: 1,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          gap: 8,
                          padding: "4px 0 6px",
                          background: "var(--bg)",
                          color: "var(--text-dim)",
                          fontSize: 10,
                          fontWeight: 600,
                          textTransform: "uppercase",
                        }}
                      >
                        <span>{SLASH_SOURCE_GROUP_LABEL[group.source]}</span>
                        <span style={{ fontFamily: "var(--font-mono)", fontWeight: 500 }}>{group.items.length}</span>
                      </div>
                      <div
                        style={{
                          display: "grid",
                          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                          gap: 8,
                        }}
                      >
                        {group.items.map(({ command, index }) => {
                          const active = index === slashActiveIndex;
                          return (
                            <button
                              key={`${command.source}:${command.name}`}
                              ref={(node) => {
                                slashItemRefs.current[index] = node;
                              }}
                              type="button"
                              onMouseDown={(e) => {
                                e.preventDefault();
                                applySlashCommand(command);
                              }}
                              onMouseEnter={() => setSlashActiveIndex(index)}
                              style={{
                                width: "100%",
                                minWidth: 0,
                                minHeight: 58,
                                display: "flex",
                                flexDirection: "column",
                                gap: 4,
                                justifyContent: "center",
                                padding: "9px 10px",
                                border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
                                borderRadius: 7,
                                background: active ? "var(--bg-selected)" : "var(--bg-panel)",
                                color: "var(--text)",
                                cursor: "pointer",
                                textAlign: "left",
                                boxShadow: active ? "0 0 0 1px color-mix(in srgb, var(--accent) 28%, transparent)" : "none",
                              }}
                            >
                              <span style={{
                                fontSize: 13,
                                fontFamily: "var(--font-mono)",
                                overflowWrap: "anywhere",
                                wordBreak: "break-word",
                              }}>
                                /{command.name}
                              </span>
                              {command.description && (
                                <span style={{
                                  display: "-webkit-box",
                                  WebkitBoxOrient: "vertical",
                                  WebkitLineClamp: 2,
                                  overflow: "hidden",
                                  fontSize: 11,
                                  lineHeight: 1.35,
                                  color: "var(--text-dim)",
                                }}>
                                  {command.description}
                                </span>
                              )}
                            </button>
                          );
                        })}
                      </div>
                    </section>
                  ))
                )}
              </div>
            </div>
          )}
          {atMenuOpen && atQuery !== null && popupRect && (() => {
            const indexLoading = fileIndexLoading && (!fileIndex || fileIndex.cwd !== cwd);
            const matchCountLabel = atMatches.length === 1 ? "1 个匹配" : `${atMatches.length} 个匹配`;
            // With a truncated index, local results are provisional — the
            // debounced server search over the full listing replaces them.
            const truncatedHint = fileIndex?.truncated && !serverResultInUse
              ? (atQuery.query ? " · 正在搜索全部文件…" : " · 索引已截断")
              : "";
            return (
              <div
                style={{
                  position: "fixed",
                  left: popupRect.left,
                  width: popupRect.width,
                  bottom: popupRect.bottom,
                  zIndex: 1000,
                  background: "var(--bg)",
                  border: "1px solid var(--border)",
                  borderRadius: 8,
                  boxShadow: "0 -6px 20px rgba(0,0,0,0.12)",
                  overflow: "hidden",
                  maxHeight: popupRect.maxH,
                }}
              >
                <div
                  style={{
                    padding: "8px 10px",
                    borderBottom: "1px solid var(--border)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 8,
                    fontSize: 11,
                    color: "var(--text-dim)",
                  }}
                >
                  <span>
                    {indexLoading
                      ? "正在加载文件..."
                      : `文件 · ${matchCountLabel}${truncatedHint}`}
                  </span>
                  <span style={{ fontFamily: "var(--font-mono)" }}>Tab / Enter</span>
                </div>
                <div style={{ maxHeight: popupRect.maxH - 34, overflowY: "auto", padding: 4 }}>
                  {!indexLoading && atMatches.length === 0 ? (
                    <div style={{ padding: "6px 8px", fontSize: 12, color: "var(--text-dim)" }}>
                      {needsServerSearch && !serverResultInUse ? "正在搜索…" : "没有匹配的文件"}
                    </div>
                  ) : (
                    atMatches.map((entry, index) => {
                      const active = index === atActiveIndex;
                      const name = entry.path.split("/").pop() ?? entry.path;
                      const dirPrefix = entry.path.slice(0, entry.path.length - name.length);
                      return (
                        <button
                          key={`${entry.isDir ? "d" : "f"}:${entry.path}`}
                          ref={(node) => {
                            atItemRefs.current[index] = node;
                          }}
                          type="button"
                          onMouseDown={(e) => {
                            e.preventDefault();
                            applyAtCompletion(entry);
                          }}
                          onMouseEnter={() => setAtActiveIndex(index)}
                          style={{
                            width: "100%",
                            display: "flex",
                            alignItems: "center",
                            gap: 8,
                            padding: "6px 8px",
                            border: "none",
                            borderRadius: 6,
                            background: active ? "var(--bg-selected)" : "none",
                            color: "var(--text)",
                            cursor: "pointer",
                            textAlign: "left",
                            fontSize: 12.5,
                            fontFamily: "var(--font-mono)",
                          }}
                        >
                          <span style={{ flexShrink: 0, display: "flex", alignItems: "center" }}>
                            {entry.isDir ? <FolderIcon size={14} /> : getFileIcon(name, 14)}
                          </span>
                          <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {dirPrefix && <span style={{ color: "var(--text-dim)" }}>{dirPrefix}</span>}
                            {name}
                            {entry.isDir && <span style={{ color: "var(--text-dim)" }}>/</span>}
                          </span>
                        </button>
                      );
                    })
                  )}
                </div>
              </div>
            );
          })()}
          <div
            style={{
              display: "flex",
              gap: 8,
              alignItems: "center",
              background: "var(--bg)",
              border: `1px solid ${isStreaming && (onSteer || onFollowUp)
                ? "rgba(234,179,8,0.4)"
                : "color-mix(in srgb, var(--border) 70%, transparent)"}`,
              borderRadius: 14,
              padding: "10px 10px 10px 14px",
              boxShadow: "0 1px 2px rgba(15,23,42,0.04), 0 8px 24px -12px rgba(15,23,42,0.10)",
              transition: "border-color 0.15s, background 0.15s, box-shadow 0.15s",
            } as React.CSSProperties}
          >
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              updateAtQuery(e.target.value, e.target.selectionStart);
            }}
            onSelect={(e) => {
              const el = e.currentTarget;
              updateAtQuery(el.value, el.selectionStart);
            }}
            onKeyDown={handleKeyDown}
            onCompositionStart={() => {
              isComposingRef.current = true;
            }}
            onCompositionEnd={(e) => {
              isComposingRef.current = false;
              lastCompositionEndAtRef.current = Date.now();
              const el = e.currentTarget;
              updateAtQuery(el.value, el.selectionStart);
            }}
            onInput={handleInput}
            onPaste={handlePaste}
            placeholder={
              isStreaming && (onSteer || onFollowUp)
                ? "立即转向 / 排队追问..."
                : isStreaming ? "智能体运行中…"
                : isMobile
                  ? "输入消息…  /  命令  ·  @  文件"
                  : "输入消息…输入 / 查看命令，@ 引用文件　·　Enter 发送 · Shift+Enter 换行"
            }
            rows={1}
            style={{
              flex: 1,
              background: "none",
              border: "none",
              outline: "none",
              resize: "none",
              color: "var(--text)",
              fontSize: 14,
              lineHeight: 1.6,
              fontFamily: "inherit",
              minHeight: 24,
              maxHeight: 200,
              overflow: "auto",
            }}
          />

          {isStreaming ? (
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0, alignSelf: "flex-end" }}>
              {onSteer && (
                <button
                  onClick={() => sendQueued("steer")}
                  disabled={!canQueueStreamingMessage}
                  title="中断当前运行并立即插入此消息"
                  style={{
                    display: "flex", alignItems: "center", gap: 5,
                    padding: "7px 12px",
                    background: canQueueStreamingMessage ? "rgba(234,179,8,0.12)" : "none",
                    border: "1px solid rgba(234,179,8,0.35)",
                    borderRadius: 8,
                    color: canQueueStreamingMessage ? "rgba(180,130,0,1)" : "var(--text-dim)",
                    cursor: canQueueStreamingMessage ? "pointer" : "not-allowed",
                    fontSize: 13, fontWeight: 600, letterSpacing: "-0.01em",
                    transition: "background 0.12s",
                  }}
                >
                  <svg width="12" height="12" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M5 1 L9 5 L5 9" /><line x1="1" y1="5" x2="9" y2="5" />
                  </svg>
                  转向
                </button>
              )}
              {onFollowUp && (
                <button
                  onClick={() => sendQueued("followup")}
                  disabled={!canQueueStreamingMessage}
                  title="在智能体结束后排队发送此消息"
                  style={{
                    display: "flex", alignItems: "center", gap: 5,
                    padding: "7px 12px",
                    background: canQueueStreamingMessage ? "rgba(129,140,248,0.12)" : "none",
                    border: "1px solid rgba(129,140,248,0.35)",
                    borderRadius: 8,
                    color: canQueueStreamingMessage ? "rgba(99,102,241,1)" : "var(--text-dim)",
                    cursor: canQueueStreamingMessage ? "pointer" : "not-allowed",
                    fontSize: 13, fontWeight: 600, letterSpacing: "-0.01em",
                    transition: "background 0.12s",
                  }}
                >
                  <svg width="12" height="12" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="5" y1="1" x2="5" y2="6" /><polyline points="2.5 3.5 5 1 7.5 3.5" />
                    <line x1="2" y1="9" x2="8" y2="9" />
                  </svg>
                  追问
                </button>
              )}
            </div>
          ) : (
            <button
              onClick={handleSend}
              disabled={!value.trim() || isUploading}
              style={{
                flexShrink: 0,
                alignSelf: "flex-end",
                display: "flex", alignItems: "center", gap: 6,
                padding: "7px 14px",
                background: value.trim() && !isUploading ? "var(--accent)" : "var(--bg-panel)",
                border: "none",
                borderRadius: 8,
                color: value.trim() && !isUploading ? "#fff" : "var(--text-dim)",
                cursor: value.trim() && !isUploading ? "pointer" : "not-allowed",
                fontSize: 13,
                fontWeight: 600,
                letterSpacing: "-0.01em",
                boxShadow: value.trim() && !isUploading ? "0 1px 3px rgba(37,99,235,0.25)" : "none",
                transition: "background 0.15s, box-shadow 0.15s",
              }}
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="2" y1="7" x2="11" y2="7" />
                <polyline points="7.5 3 12 7 7.5 11" />
              </svg>
            </button>
          )}
          </div>
        </div>

        {/* Bottom bar: left | center (context) | right */}
        <div style={{
          marginTop: 8,
          display: isMobile ? "grid" : "flex",
          gridTemplateColumns: isMobile ? "minmax(0, 1fr) auto" : undefined,
          alignItems: "center",
          gap: 6,
        }}>

          {/* LEFT: attach + model selector + thinking (idle) | steer/followup toggle (streaming) */}
          <div style={{ flex: isMobile ? "1 1 auto" : "0 0 auto", minWidth: 0, display: "flex", alignItems: "center", gap: 2 }}>
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={isStreaming || !cwd || isUploading}
              title={!cwd ? "需要先选择工作区目录" : "添加文件"}
              style={{
                flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center",
                width: 32, height: 32, padding: 0,
                background: "none", border: "none",
                borderRadius: 9,
                color: isUploading ? "var(--accent)" : "var(--text-muted)",
                cursor: (isStreaming || !cwd || isUploading) ? "not-allowed" : "pointer",
                opacity: (isStreaming || !cwd) ? 0.5 : 1,
                transition: "background 0.12s, color 0.12s",
              }}
              onMouseEnter={(e) => {
                if (isStreaming || !cwd || isUploading) return;
                e.currentTarget.style.background = "var(--bg-hover)";
                e.currentTarget.style.color = "var(--text)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "none";
                e.currentTarget.style.color = isUploading ? "var(--accent)" : "var(--text-muted)";
              }}
            >
              {isUploading ? (
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" style={{ animation: "spin 0.8s linear infinite" }}>
                  <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                </svg>
              ) : (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="8" x2="12" y2="16" />
                  <line x1="8" y1="12" x2="16" y2="12" />
                </svg>
              )}
            </button>
            {/* Model selector — visible always, disabled during streaming */}
            {modelOptions.length > 0 && currentName && onModelChange && (
                <div ref={dropdownRef} style={{ position: "relative", flex: isMobile ? "1 1 auto" : undefined, minWidth: 0 }}>
                  <button
                    onClick={(e) => {
                      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                      setModelDropdownRect({ top: rect.top, left: rect.left, width: rect.width });
                      setModelDropdownOpen((v) => !v);
                    }}
                    disabled={isStreaming}
                    style={{
                      display: "flex", alignItems: "center", gap: 6,
                      justifyContent: isMobile ? "flex-start" : undefined,
                      padding: isMobile ? "8px 10px" : "8px 12px",
                      height: 32,
                      width: isMobile ? "100%" : undefined,
                      maxWidth: isMobile ? "100%" : 220,
                      overflow: "hidden",
                      background: modelDropdownOpen ? "var(--bg-hover)" : "none",
                      border: "none",
                      borderRadius: 9,
                      color: "var(--text-muted)",
                      cursor: isStreaming ? "not-allowed" : "pointer",
                      fontSize: 12,
                      opacity: isStreaming ? 0.5 : 1,
                      transition: "background 0.12s, color 0.12s",
                    }}
                    onMouseEnter={(e) => {
                      if (isStreaming) return;
                      e.currentTarget.style.background = "var(--bg-hover)";
                      e.currentTarget.style.color = "var(--text)";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = modelDropdownOpen ? "var(--bg-hover)" : "none";
                      e.currentTarget.style.color = "var(--text-muted)";
                    }}
                  >
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="4" y="4" width="16" height="16" rx="2" />
                      <rect x="9" y="9" width="6" height="6" />
                      <line x1="9" y1="1" x2="9" y2="4" /><line x1="15" y1="1" x2="15" y2="4" />
                      <line x1="9" y1="20" x2="9" y2="23" /><line x1="15" y1="20" x2="15" y2="23" />
                      <line x1="20" y1="9" x2="23" y2="9" /><line x1="20" y1="14" x2="23" y2="14" />
                      <line x1="1" y1="9" x2="4" y2="9" /><line x1="1" y1="14" x2="4" y2="14" />
                    </svg>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>{currentName}</span>
                  </button>
                  {modelDropdownOpen && modelDropdownRect && (() => {
                    const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
                    const bottom = viewportHeight - modelDropdownRect.top + 6;
                    const maxH = Math.max(120, Math.min(modelDropdownRect.top - 8, viewportHeight * 0.6));
                    // On mobile, pin to a small left margin and cap width to the
                    // viewport so long model names never push the panel off-screen.
                    const panelPos: React.CSSProperties = isMobile
                      ? { left: 8, right: 8, maxWidth: "calc(100vw - 16px)" }
                      : { left: modelDropdownRect.left, width: "max-content", minWidth: modelDropdownRect.width };
                    return (
                      <div ref={modelDropdownPanelRef} style={{
                      position: "fixed",
                      bottom,
                      ...panelPos,
                      zIndex: 500, background: "var(--bg)", border: "1px solid var(--border)",
                      borderRadius: 8, boxShadow: "0 -4px 16px rgba(0,0,0,0.10)",
                      overflow: "hidden", maxHeight: maxH, overflowY: "auto",
                      }}>
                      {modelsByProvider.map((group, gi) => (
                        <div key={group.provider}>
                          {(modelsByProvider.length > 1) && (
                            <div style={{
                              padding: "6px 12px 4px",
                              fontSize: 10, fontWeight: 600, color: "var(--text-dim)",
                              textTransform: "uppercase", letterSpacing: "0.07em",
                              borderTop: gi > 0 ? "1px solid var(--border)" : "none",
                            }}>
                              {group.provider}
                            </div>
                          )}
                          {group.options.map((opt) => {
                            const isActive = opt.modelId === model?.modelId && opt.provider === model?.provider;
                            return (
                              <button
                                key={`${opt.provider}:${opt.modelId}`}
                                onClick={() => { setModelDropdownOpen(false); if (!isActive || isAutoModelSelection) onModelChange(opt.provider, opt.modelId); }}
                                style={{
                                  display: "flex", alignItems: "center", gap: 8,
                                  width: "100%", padding: "7px 12px",
                                  background: isActive ? "var(--bg-selected)" : "none",
                                  border: "none",
                                  color: isActive ? "var(--text)" : "var(--text-muted)",
                                  cursor: "pointer", fontSize: 12, textAlign: "left",
                                  fontWeight: isActive ? 600 : 400,
                                  whiteSpace: "nowrap",
                                }}
                                onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.background = "var(--bg-hover)"; }}
                                onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.background = "none"; }}
                              >
                                {isActive
                                  ? <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><polyline points="1.5 5 4 7.5 8.5 2.5" /></svg>
                                  : <span style={{ width: 10, flexShrink: 0 }} />}
                                {opt.name}
                              </button>
                            );
                          })}
                        </div>
                      ))}
                    </div>
                    );
                  })()}
                </div>
            )}
            {/* 分隔竖线：模型 | 推理 成组 */}
            {!isStreaming && onThinkingLevelChange && (
              <div style={{ width: 1, height: 18, background: "var(--border)", margin: "0 4px", flexShrink: 0 }} />
            )}
            {!isStreaming && onThinkingLevelChange && (
              <div ref={thinkingDropdownRef} style={{ position: "relative" }}>
                <button
                  onClick={() => !isStreaming && setThinkingDropdownOpen((v) => !v)}
                  disabled={isStreaming}
                  title={`更改推理级别：${thinkingDisplayLabel}`}
                  aria-label="更改推理级别"
                  style={{
                    display: "flex", alignItems: "center", justifyContent: "center", gap: 5,
                    padding: isMobile ? "0 6px" : "8px 12px",
                    width: isMobile ? "auto" : undefined,
                    height: 32,
                    background: thinkingDropdownOpen ? "var(--bg-hover)" : "none",
                    border: "none",
                    borderRadius: 9,
                    color: "var(--text-muted)",
                    cursor: isStreaming ? "not-allowed" : "pointer",
                    fontSize: 12,
                    opacity: isStreaming ? 0.5 : 1,
                    transition: "background 0.12s, color 0.12s",
                  }}
                  onMouseEnter={(e) => {
                    if (isStreaming) return;
                    e.currentTarget.style.background = "var(--bg-hover)";
                    e.currentTarget.style.color = "var(--text)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = thinkingDropdownOpen ? "var(--bg-hover)" : "none";
                    e.currentTarget.style.color = "var(--text-muted)";
                  }}
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M9.5 2A5.5 5.5 0 0 0 4 7.5c0 1.7.78 3.21 2 4.21V14a1 1 0 0 0 1 1h5a1 1 0 0 0 1-1v-2.29c1.22-1 2-2.51 2-4.21A5.5 5.5 0 0 0 9.5 2z" />
                    <line x1="7" y1="18" x2="12" y2="18" />
                    <line x1="8" y1="21" x2="11" y2="21" />
                  </svg>
                  {(!isMobile || controlsMenuOpen) && <span style={{ whiteSpace: "nowrap" }}>{thinkingDisplayLabel}</span>}
                </button>
                {thinkingDropdownOpen && (
                  <div style={{
                    position: "absolute", bottom: "calc(100% + 6px)", left: 0,
                    zIndex: 100, background: "var(--bg)", border: "1px solid var(--border)",
                    borderRadius: 8, boxShadow: "0 -4px 16px rgba(0,0,0,0.10)",
                    overflow: "hidden", minWidth: 180,
                  }}>
                    {THINKING_LEVELS.filter((lvl) => {
                      if (!availableThinkingLevels) return true;
                      if (lvl === "auto") return true;
                      return availableThinkingLevels.includes(lvl);
                    }).map((lvl) => {
                      const isActive = (thinkingLevel ?? "auto") === lvl;
                      const desc = THINKING_LEVEL_DESC[lvl];
                      const mappedVal = (lvl !== "auto" && thinkingLevelMap) ? thinkingLevelMap[lvl] : undefined;
                      const displayLabel = (mappedVal != null && mappedVal !== lvl) ? mappedVal : lvl;
                      const showOriginal = mappedVal != null && mappedVal !== lvl;
                      return (
                        <button
                          key={lvl}
                          onClick={() => { setThinkingDropdownOpen(false); if (!isActive) onThinkingLevelChange(lvl); }}
                          style={{
                            display: "flex", alignItems: "center", gap: 8,
                            width: "100%", padding: "7px 12px",
                            background: isActive ? "var(--bg-selected)" : "none",
                            border: "none",
                            color: isActive ? "var(--text)" : "var(--text-muted)",
                            cursor: "pointer", fontSize: 12, textAlign: "left",
                            fontWeight: isActive ? 600 : 400,
                            whiteSpace: "nowrap",
                          }}
                          onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.background = "var(--bg-hover)"; }}
                          onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.background = "none"; }}
                        >
                          {isActive
                            ? <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><polyline points="1.5 5 4 7.5 8.5 2.5" /></svg>
                            : <span style={{ width: 10, flexShrink: 0 }} />}
                          <span style={{ flex: 1 }}>
                            {displayLabel}
                            {showOriginal && <span style={{ fontSize: 10, color: "var(--text-dim)", fontFamily: "var(--font-mono)", marginLeft: 5 }}>({lvl})</span>}
                          </span>
                          <span style={{ fontSize: 11, color: "var(--text-dim)", marginLeft: 8 }}>{desc}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* spacer */}
          {!isMobile && <div style={{ flex: 1 }} />}

          {/* RIGHT: skills + tools preset + compact + sound + session info + system (idle) | Stop + sound (streaming) */}
          <div ref={controlsMenuRef} style={{
            flex: "0 0 auto",
            display: "flex",
            alignItems: "center",
            justifyContent: "flex-end",
            position: "relative",
            marginLeft: isMobile ? 0 : "auto",
          }}>
            {isMobile && (
              <button
                type="button"
                title={controlsMenuOpen ? undefined : "更多控件"}
                aria-label="更多控件"
                aria-expanded={controlsMenuOpen}
                aria-hidden={controlsMenuOpen || undefined}
                tabIndex={controlsMenuOpen ? -1 : undefined}
                onClick={() => {
                  setModelDropdownOpen(false);
                  setControlsMenuOpen(true);
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: "100%",
                  height: 32,
                  padding: "8px 10px",
                  background: "none",
                  border: "none",
                  borderRadius: 9,
                  color: "var(--text-muted)",
                  cursor: controlsMenuOpen ? "default" : "pointer",
                  fontSize: 12,
                  fontWeight: 500,
                  visibility: controlsMenuOpen ? "hidden" : "visible",
                  pointerEvents: controlsMenuOpen ? "none" : "auto",
                  transition: "background 0.12s, color 0.12s",
                }}
                onMouseEnter={(e) => {
                  if (controlsMenuOpen) return;
                  e.currentTarget.style.background = "var(--bg-hover)";
                  e.currentTarget.style.color = "var(--text)";
                }}
                onMouseLeave={(e) => {
                  if (controlsMenuOpen) return;
                  e.currentTarget.style.background = "none";
                  e.currentTarget.style.color = "var(--text-muted)";
                }}
              >
                更多
              </button>
            )}
            <div style={{
              display: isMobile ? (controlsMenuOpen ? "flex" : "none") : "flex",
              alignItems: "center",
              gap: isMobile ? 1 : 2,
              ...(isMobile ? {
                position: "absolute",
                right: 0,
                bottom: 0,
                zIndex: 60,
                padding: 1,
                width: "max-content",
                maxWidth: "calc(100vw - 32px)",
                flexWrap: "nowrap",
                justifyContent: "flex-end",
                border: "1px solid color-mix(in srgb, var(--border) 72%, transparent)",
                borderRadius: 10,
                background: "color-mix(in srgb, var(--bg-panel) 92%, var(--bg))",
                boxShadow: "0 8px 24px rgba(0,0,0,0.14)",
                backdropFilter: "blur(10px)",
              } : null),
            }}>
            {!isStreaming && cwd && (
              <div style={{ position: "relative" }}>
                <button
                  ref={skillsTriggerRef}
                  onClick={(e) => {
                    if (isStreaming) return;
                    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                    setSkillsDropdownRect({ top: rect.top, left: rect.left, width: rect.width });
                    setSkillsDropdownOpen((v) => !v);
                  }}
                  disabled={isStreaming || !cwd}
                  title={enabledSkills.length > 0 ? `技能（${enabledSkills.length} 个已启用）` : "技能"}
                  aria-label="技能"
                  aria-haspopup="menu"
                  aria-expanded={skillsDropdownOpen}
                  style={{
                    display: "flex", alignItems: "center", justifyContent: "center", gap: 5,
                    padding: isMobile ? "0 6px" : "8px 12px",
                    width: isMobile ? "auto" : undefined,
                    height: 32,
                    background: skillsDropdownOpen ? "var(--bg-hover)" : "none",
                    border: "none",
                    borderRadius: 9,
                    color: "var(--text-muted)",
                    cursor: isStreaming ? "not-allowed" : "pointer",
                    fontSize: 12,
                    opacity: isStreaming ? 0.5 : 1,
                    transition: "background 0.12s, color 0.12s",
                  }}
                  onMouseEnter={(e) => {
                    if (isStreaming) return;
                    e.currentTarget.style.background = "var(--bg-hover)";
                    e.currentTarget.style.color = "var(--text)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = skillsDropdownOpen ? "var(--bg-hover)" : "none";
                    e.currentTarget.style.color = "var(--text-muted)";
                  }}
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 2L2 7l10 5 10-5-10-5z" />
                    <path d="M2 17l10 5 10-5" />
                    <path d="M2 12l10 5 10-5" />
                  </svg>
                  {(!isMobile || controlsMenuOpen) && <span style={{ whiteSpace: "nowrap" }}>技能</span>}
                </button>
                {skillsDropdownOpen && skillsDropdownRect && (() => {
                  const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
                  const bottom = viewportHeight - skillsDropdownRect.top + 6;
                  const maxH = Math.max(160, Math.min(skillsDropdownRect.top - 8, viewportHeight * 0.6));
                  const panelPos: React.CSSProperties = isMobile
                    ? { left: 8, right: 8, maxWidth: "calc(100vw - 16px)" }
                    : { left: skillsDropdownRect.left, width: "max-content", minWidth: Math.max(skillsDropdownRect.width, 180) };
                  return (
                    <div ref={skillsDropdownPanelRef} style={{
                      position: "fixed",
                      bottom,
                      ...panelPos,
                      zIndex: 500, background: "var(--bg)", border: "1px solid var(--border)",
                      borderRadius: 8, boxShadow: "0 -4px 16px rgba(0,0,0,0.10)",
                      overflow: "hidden", maxHeight: maxH, display: "flex", flexDirection: "column",
                    }}>
                      <div style={{ padding: "6px 12px", fontSize: 10, fontWeight: 600, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.07em", borderBottom: "1px solid var(--border)" }}>
                        技能
                      </div>
                      <div style={{ overflowY: "auto", flex: 1, minHeight: 0 }}>
                        {skillsLoading ? (
                          <div style={{ padding: "12px", fontSize: 12, color: "var(--text-dim)" }}>正在加载技能…</div>
                        ) : enabledSkills.length === 0 ? (
                          <div style={{ padding: "12px", fontSize: 12, color: "var(--text-dim)" }}>暂无已启用的技能</div>
                        ) : (
                          enabledSkills.map((s) => (
                            <button
                              key={s.name}
                              onClick={() => applySkill(s.name)}
                              style={{
                                display: "flex", alignItems: "center", gap: 8,
                                width: "100%", padding: "7px 12px",
                                background: "none", border: "none",
                                color: "var(--text-muted)",
                                cursor: "pointer", fontSize: 12, textAlign: "left",
                                whiteSpace: "nowrap",
                                transition: "background 0.12s, color 0.12s",
                              }}
                              onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--text)"; }}
                              onMouseLeave={(e) => { e.currentTarget.style.background = "none"; e.currentTarget.style.color = "var(--text-muted)"; }}
                            >
                              <span style={{ color: "var(--accent)", fontFamily: "var(--font-mono)", fontSize: 11 }}>/</span>
                              <span style={{ flex: 1 }}>{s.name}</span>
                            </button>
                          ))
                        )}
                      </div>
                      {onManageSkills && (
                        <button
                          onClick={() => { setSkillsDropdownOpen(false); onManageSkills(); }}
                          style={{
                            display: "flex", alignItems: "center", justifyContent: "flex-start", gap: 6,
                            width: "100%", padding: "8px 12px",
                            background: "none", borderTop: "1px solid var(--border)",
                            color: "var(--accent)",
                            cursor: "pointer", fontSize: 12, fontWeight: 500, whiteSpace: "nowrap",
                            transition: "background 0.12s",
                          }}
                          onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
                          onMouseLeave={(e) => { e.currentTarget.style.background = "none"; }}
                        >
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <circle cx="12" cy="12" r="3" />
                            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                          </svg>
                          管理技能…
                        </button>
                      )}
                    </div>
                  );
                })()}
              </div>
            )}
            {!isStreaming && onToolPresetChange && (
              <div ref={toolDropdownRef} style={{ position: "relative" }}>
                <button
                  onClick={() => !isStreaming && setToolDropdownOpen((v) => !v)}
                  disabled={isStreaming}
                  title={`更改工具预设：${toolPresetLabel}`}
                  aria-label="更改工具预设"
                  style={{
                    display: "flex", alignItems: "center", justifyContent: "center", gap: 5,
                    padding: isMobile ? "0 6px" : "8px 12px",
                    width: isMobile ? "auto" : undefined,
                    height: 32,
                    background: toolDropdownOpen ? "var(--bg-hover)" : "none",
                    border: "none",
                    borderRadius: 9,
                    color: "var(--text-muted)",
                    cursor: isStreaming ? "not-allowed" : "pointer",
                    fontSize: 12,
                    opacity: isStreaming ? 0.5 : 1,
                    transition: "background 0.12s, color 0.12s",
                  }}
                  onMouseEnter={(e) => {
                    if (isStreaming) return;
                    e.currentTarget.style.background = "var(--bg-hover)";
                    e.currentTarget.style.color = "var(--text)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = toolDropdownOpen ? "var(--bg-hover)" : "none";
                    e.currentTarget.style.color = "var(--text-muted)";
                  }}
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
                  </svg>
                  {(!isMobile || controlsMenuOpen) && <span style={{ whiteSpace: "nowrap" }}>{toolPresetLabel}</span>}
                </button>
                {toolDropdownOpen && (
                  <div style={{
                    position: "absolute", bottom: "calc(100% + 6px)", right: 0,
                    zIndex: 100, background: "var(--bg)", border: "1px solid var(--border)",
                    borderRadius: 8, boxShadow: "0 -4px 16px rgba(0,0,0,0.10)",
                    overflow: "hidden", minWidth: 120,
                  }}>
                    {TOOL_PRESETS.map((lvl) => {
                      const preset = TOOL_PRESET_MAP[lvl];
                      const isActive = (toolPreset ?? "default") === preset;
                      const desc = lvl === "off" ? "无工具，只读" : lvl === "default" ? "4 个内置工具" : "全部内置工具";
                      return (
                        <button
                          key={lvl}
                          onClick={() => { setToolDropdownOpen(false); if (!isActive) onToolPresetChange(preset); }}
                          style={{
                            display: "flex", alignItems: "center", gap: 8,
                            width: "100%", padding: "7px 12px",
                            background: isActive ? "var(--bg-selected)" : "none",
                            border: "none",
                            color: isActive ? "var(--text)" : "var(--text-muted)",
                            cursor: "pointer", fontSize: 12, textAlign: "left",
                            fontWeight: isActive ? 600 : 400,
                            whiteSpace: "nowrap",
                          }}
                          onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.background = "var(--bg-hover)"; }}
                          onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.background = "none"; }}
                        >
                          {isActive
                            ? <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><polyline points="1.5 5 4 7.5 8.5 2.5" /></svg>
                            : <span style={{ width: 10, flexShrink: 0 }} />}
                          <span style={{ flex: 1 }}>{lvl}</span>
                          <span style={{ fontSize: 11, color: "var(--text-dim)", marginLeft: 8 }}>{desc}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {!isStreaming && onCompact && (
              <div style={{ position: "relative" }}>
                {compactError && (
                  <div style={{
                    position: "absolute", bottom: "calc(100% + 6px)", right: 0,
                    background: "#1f2937", color: "#f87171",
                    fontSize: 11, padding: "4px 8px", borderRadius: 5,
                    whiteSpace: "nowrap", pointerEvents: "none",
                    boxShadow: "0 2px 8px rgba(0,0,0,0.2)", zIndex: 50,
                  }}>
                    {compactError}
                  </div>
                )}
                <button
                  onClick={isCompacting ? onAbortCompaction : onCompact}
                  disabled={isStreaming && !isCompacting}
                  style={{
                    display: "flex", alignItems: "center", justifyContent: "center", gap: 5,
                    padding: isMobile ? "0 6px" : "8px 12px",
                    width: isMobile ? "auto" : undefined,
                    height: 32,
                    background: isCompacting ? "rgba(239,68,68,0.08)" : "none",
                    border: "none",
                    borderRadius: 9,
                    color: isCompacting ? "#ef4444" : "var(--text-muted)",
                    cursor: (isStreaming && !isCompacting) ? "not-allowed" : "pointer",
                    fontSize: 12, opacity: (isStreaming && !isCompacting) ? 0.5 : 1,
                    transition: "background 0.12s, color 0.12s",
                  }}
                  onMouseEnter={(e) => {
                    if (isStreaming && !isCompacting) return;
                    e.currentTarget.style.background = isCompacting ? "rgba(239,68,68,0.16)" : "var(--bg-hover)";
                    e.currentTarget.style.color = isCompacting ? "#ef4444" : "var(--text)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = isCompacting ? "rgba(239,68,68,0.08)" : "none";
                    e.currentTarget.style.color = isCompacting ? "#ef4444" : "var(--text-muted)";
                  }}
                  title={isCompacting ? "停止压缩" : "压缩上下文"}
                  aria-label={isCompacting ? "停止压缩" : "压缩上下文"}
                >
                  {isCompacting ? (
                    <><svg width="10" height="10" viewBox="0 0 10 10" fill="none"><rect x="2" y="2" width="6" height="6" rx="1" fill="currentColor" /></svg>{(!isMobile || controlsMenuOpen) && <span style={{ whiteSpace: "nowrap" }}>压缩中…</span>}</>
                  ) : (
                    <><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="4 14 10 14 10 20" /><polyline points="20 10 14 10 14 4" />
                      <line x1="10" y1="14" x2="3" y2="21" /><line x1="21" y1="3" x2="14" y2="10" />
                    </svg>{(!isMobile || controlsMenuOpen) && <span style={{ whiteSpace: "nowrap" }}>压缩</span>}</>
                  )}
                </button>
              </div>
            )}

            {isStreaming && (
              <button
                onClick={onAbort}
                title="停止智能体"
                style={{
                  display: "flex", alignItems: "center", gap: 6,
                  padding: "8px 14px",
                  height: 32,
                  background: "rgba(239,68,68,0.08)",
                  border: "1px solid rgba(239,68,68,0.3)",
                  borderRadius: 9,
                  color: "#ef4444",
                  cursor: "pointer",
                  fontSize: 12, fontWeight: 600,
                  whiteSpace: "nowrap", letterSpacing: "-0.01em",
                  transition: "background 0.12s",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(239,68,68,0.16)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "rgba(239,68,68,0.08)"; }}
              >
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                  <rect x="1.5" y="1.5" width="7" height="7" rx="1.5" fill="currentColor" />
                </svg>
                停止
              </button>
            )}

            {!isStreaming && onOpenSessionInfo && (
              <button
                onClick={onOpenSessionInfo}
                disabled={isStreaming}
                title="会话信息"
                aria-label="会话信息"
                style={{
                  display: (!isMobile || controlsMenuOpen) ? "flex" : "none",
                  alignItems: "center", justifyContent: "center", gap: 5,
                  padding: isMobile ? "0 6px" : "8px 12px",
                  width: isMobile ? "auto" : undefined,
                  height: 32,
                  background: "none",
                  border: "none",
                  borderRadius: 9,
                  color: "var(--text-muted)",
                  cursor: "pointer",
                  fontSize: 12,
                  transition: "background 0.12s, color 0.12s",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--text)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "none"; e.currentTarget.style.color = "var(--text-muted)"; }}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="16" x2="12" y2="12" />
                  <line x1="12" y1="8" x2="12.01" y2="8" />
                </svg>
                {(!isMobile || controlsMenuOpen) && <span style={{ whiteSpace: "nowrap" }}>会话信息</span>}
              </button>
            )}
            {(!isMobile || controlsMenuOpen) && !isStreaming && onToggleBranchPanel && branchTree && (
              <button
                onClick={onToggleBranchPanel}
                disabled={isStreaming}
                title="分支"
                aria-label="分支"
                style={{
                  display: (!isMobile || controlsMenuOpen) ? "flex" : "none",
                  alignItems: "center", justifyContent: "center", gap: 5,
                  padding: isMobile ? "0 6px" : "8px 12px",
                  width: isMobile ? "auto" : undefined,
                  height: 32,
                  background: "none",
                  border: "none",
                  borderRadius: 9,
                  color: "var(--text-muted)",
                  cursor: "pointer",
                  fontSize: 12,
                  transition: "background 0.12s, color 0.12s",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--text)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "none"; e.currentTarget.style.color = "var(--text-muted)"; }}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                  <line x1="6" y1="3" x2="6" y2="15" />
                  <circle cx="18" cy="6" r="3" />
                  <circle cx="6" cy="18" r="3" />
                  <path d="M18 9a9 9 0 0 1-9 9" />
                </svg>
                {(!isMobile || controlsMenuOpen) && <span style={{ whiteSpace: "nowrap" }}>分支</span>}
              </button>
            )}
            {!isStreaming && onOpenSystemPrompt && (
              <button
                onClick={onOpenSystemPrompt}
                disabled={isStreaming}
                title="系统提示词"
                aria-label="系统提示词"
                style={{
                  display: (!isMobile || controlsMenuOpen) ? "flex" : "none",
                  alignItems: "center", justifyContent: "center", gap: 5,
                  padding: isMobile ? "0 6px" : "8px 12px",
                  width: isMobile ? "auto" : undefined,
                  height: 32,
                  background: "none",
                  border: "none",
                  borderRadius: 9,
                  color: "var(--text-muted)",
                  cursor: "pointer",
                  fontSize: 12,
                  transition: "background 0.12s, color 0.12s",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--text)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "none"; e.currentTarget.style.color = "var(--text-muted)"; }}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                  <line x1="8" y1="13" x2="16" y2="13" />
                  <line x1="8" y1="17" x2="13" y2="17" />
                </svg>
                {(!isMobile || controlsMenuOpen) && <span style={{ whiteSpace: "nowrap" }}>系统</span>}
              </button>
            )}
            {onSoundToggle !== undefined && (
              <button
                onClick={onSoundToggle}
                title={soundEnabled ? "关闭完成提示音" : "开启完成提示音"}
                aria-label={soundEnabled ? "关闭完成提示音" : "开启完成提示音"}
                style={{
                  display: "flex", alignItems: "center", justifyContent: "center", gap: 5,
                  width: isMobile ? 32 : 32,
                  height: 32,
                  padding: 0,
                  background: "none",
                  border: "none",
                  borderRadius: 9,
                  color: soundEnabled ? "var(--text-muted)" : "var(--text-dim)",
                  cursor: "pointer",
                  opacity: soundEnabled ? 1 : 0.55,
                  transition: "background 0.12s, color 0.12s, opacity 0.12s",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = "var(--bg-hover)";
                  e.currentTarget.style.color = "var(--text)";
                  e.currentTarget.style.opacity = "1";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "none";
                  e.currentTarget.style.color = soundEnabled ? "var(--text-muted)" : "var(--text-dim)";
                  e.currentTarget.style.opacity = soundEnabled ? "1" : "0.55";
                }}
              >
                {soundEnabled ? (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                    <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                    <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
                  </svg>
                ) : (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                    <line x1="23" y1="9" x2="17" y2="15" />
                    <line x1="17" y1="9" x2="23" y2="15" />
                  </svg>
                )}
              </button>
            )}
            {isMobile && controlsMenuOpen && (
              <button
                type="button"
                title="收起控件"
                aria-label="收起控件"
                aria-expanded={true}
                onClick={() => {
                  setToolDropdownOpen(false);
                  setThinkingDropdownOpen(false);
                  setControlsMenuOpen(false);
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 36,
                  height: 32,
                  padding: 0,
                  marginLeft: 0,
                  background: "var(--bg-hover)",
                  border: "none",
                  borderLeft: "1px solid color-mix(in srgb, var(--border) 72%, transparent)",
                  borderRadius: "0 9px 9px 0",
                  color: "var(--text)",
                  cursor: "pointer",
                  transition: "background 0.12s, color 0.12s",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = "var(--bg-selected)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "var(--bg-hover)";
                }}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            )}
            </div>
          </div>

        </div>
      </div>
    </div>
  );
});
