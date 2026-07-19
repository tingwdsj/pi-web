"use client";

import { useState, useEffect, useCallback, useRef, type DragEvent } from "react";
import { useIsMobile } from "@/hooks/useIsMobile";
import type { SkillSearchResult } from "@/lib/api-types";

interface Skill {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  disableModelInvocation: boolean;
  sourceInfo: {
    source?: string;
    scope?: string;
  };
}

function shortenPath(p: string): string {
  // Match common home dir patterns: /Users/xxx, /home/xxx
  return p.replace(/^\/(?:Users|home)\/[^/]+/, "~");
}

function sourceLabel(skill: Skill): string {
  const src = skill.sourceInfo?.source;
  const scope = skill.sourceInfo?.scope;
  if (scope === "user" || src === "user") return "global";
  if (scope === "project" || src === "project") return "project";
  return "path";
}

function Toggle({
  enabled,
  loading,
  onToggle,
}: {
  enabled: boolean;
  loading: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      onClick={onToggle}
      disabled={loading}
      title={
        enabled
          ? "在模型提示词中可见 —— 点击禁用"
          : "已从模型提示词隐藏 —— 点击启用"
      }
      style={{
        flexShrink: 0,
        width: 40,
        height: 22,
        borderRadius: 11,
        border: "none",
        padding: 0,
        cursor: loading ? "wait" : "pointer",
        background: enabled ? "var(--accent)" : "var(--border)",
        position: "relative",
        transition: "background 0.18s",
        outline: "none",
      }}
    >
      <span
        style={{
          position: "absolute",
          top: 3,
          left: enabled ? 21 : 3,
          width: 16,
          height: 16,
          borderRadius: "50%",
          background: "var(--bg)",
          boxShadow: "0 1px 4px rgba(0,0,0,0.22)",
          transition: "left 0.18s cubic-bezier(.4,0,.2,1)",
        }}
      />
    </button>
  );
}

function SkillDetail({
  skill,
  cwd,
  onToggle,
  toggling,
  saveError,
}: {
  skill: Skill;
  cwd: string;
  onToggle: (skill: Skill) => void;
  toggling: boolean;
  saveError: string | null;
}) {
  const label = sourceLabel(skill);
  const enabled = !skill.disableModelInvocation;

  function displayPath(p: string): string {
    if (label === "project" && p.startsWith(cwd)) {
      const rel = p.slice(cwd.length).replace(/^[/\\]/, "");
      return `./${rel}`;
    }
    return shortenPath(p);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {/* Path + tag + toggle */}
      <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
        <span
          style={{
            fontSize: 10,
            padding: "1px 5px",
            borderRadius: 3,
            flexShrink: 0,
            background:
              label === "project"
                ? "rgba(99,102,241,0.12)"
                : "rgba(120,120,120,0.12)",
            color:
              label === "project" ? "rgba(99,102,241,0.8)" : "var(--text-dim)",
          }}
        >
          {label === "global" ? "全局" : label === "project" ? "项目" : "路径"}
        </span>
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            color: "var(--text-dim)",
            flex: 1,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {displayPath(skill.filePath)}
        </span>
        <Toggle
          enabled={enabled}
          loading={toggling}
          onToggle={() => onToggle(skill)}
        />
        {saveError && (
          <span style={{ fontSize: 12, color: "#f87171", flexShrink: 0 }}>
            {saveError}
          </span>
        )}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
        <span
          style={{ fontSize: 12, color: "var(--text-muted)", fontWeight: 500 }}
        >
          名称
        </span>
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 14,
            color: "var(--text)",
          }}
        >
          {skill.name}
        </span>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
        <span
          style={{ fontSize: 12, color: "var(--text-muted)", fontWeight: 500 }}
        >
          描述
        </span>
        <span
          style={{ fontSize: 14, color: "var(--text-muted)", lineHeight: 1.6 }}
        >
          {skill.description}
        </span>
      </div>
    </div>
  );
}

function AddSkillPanel({
  cwd,
  onInstalled,
}: {
  cwd: string;
  onInstalled: () => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SkillSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);
  const [installedPkgs, setInstalledPkgs] = useState<Set<string>>(new Set());
  const [scope, setScope] = useState<"global" | "project">("global");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const search = useCallback(async (q: string) => {
    if (!q.trim()) return;
    setSearching(true);
    setSearchError(null);
    setResults([]);
    try {
      const res = await fetch("/api/skills/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: q.trim() }),
      });
      const d = (await res.json()) as {
        results?: SkillSearchResult[];
        error?: string;
      };
      if (d.error) {
        setSearchError(d.error);
        return;
      }
      setResults(d.results ?? []);
      if ((d.results ?? []).length === 0) setSearchError("未找到技能");
    } catch (e) {
      setSearchError(String(e));
    } finally {
      setSearching(false);
    }
  }, []);

  const install = useCallback(
    async (pkg: string) => {
      setInstalling(pkg);
      setInstallError(null);
      try {
        const res = await fetch("/api/skills/install", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ package: pkg, scope, cwd }),
        });
        const d = (await res.json()) as { success?: boolean; error?: string };
        if (!res.ok || d.error) {
          setInstallError(d.error ?? `HTTP ${res.status}`);
          return;
        }
        setInstalledPkgs((prev) => new Set(prev).add(pkg));
        onInstalled();
      } catch (e) {
        setInstallError(String(e));
      } finally {
        setInstalling(null);
      }
    },
    [onInstalled, scope, cwd],
  );

  const installPath =
    scope === "global"
      ? "~/.pi/agent/skills/"
      : `${shortenPath(cwd)}/.pi/agent/skills/`;

  // ── Upload zip install ──
  const [zipBusy, setZipBusy] = useState(false);
  const [zipError, setZipError] = useState<string | null>(null);
  const [zipDone, setZipDone] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const uploadZip = useCallback(
    async (file: File) => {
      setZipBusy(true);
      setZipError(null);
      setZipDone(null);
      try {
        const form = new FormData();
        form.set("scope", scope);
        form.set("file", file);
        if (scope === "project") form.set("cwd", cwd);
        const res = await fetch("/api/skills/upload", { method: "POST", body: form });
        const d = (await res.json()) as {
          success?: boolean;
          name?: string;
          error?: string;
        };
        if (!res.ok || d.error) {
          setZipError(d.error ?? `HTTP ${res.status}`);
          return;
        }
        setZipDone(`已安装技能:${d.name ?? "(未知)"}`);
        onInstalled();
      } catch (e) {
        setZipError(String(e));
      } finally {
        setZipBusy(false);
      }
    },
    [scope, cwd, onInstalled],
  );

  const onDropZip = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      const f = Array.from(e.dataTransfer.files).find((x) =>
        x.name.toLowerCase().endsWith(".zip"),
      );
      if (f) uploadZip(f);
    },
    [uploadZip],
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* ── Header area ── */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 12,
          marginBottom: 20,
        }}
      >
        <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>
          添加技能
        </div>

        {/* Search row */}
        <div style={{ display: "flex", gap: 8 }}>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") search(query);
            }}
            placeholder="例如：react、testing、deploy"
            style={{
              flex: 1,
              padding: "7px 10px",
              fontSize: 13,
              background: "var(--bg-panel)",
              border: "1px solid var(--border)",
              borderRadius: 6,
              color: "var(--text)",
              outline: "none",
            }}
          />
          <button
            onClick={() => search(query)}
            disabled={searching || !query.trim()}
            style={{
              padding: "7px 16px",
              fontSize: 13,
              borderRadius: 6,
              border: "none",
              background: "var(--accent)",
              color: "#fff",
              cursor: searching || !query.trim() ? "not-allowed" : "pointer",
              opacity: searching || !query.trim() ? 0.5 : 1,
              flexShrink: 0,
            }}
          >
            {searching ? "搜索中…" : "搜索"}
          </button>
        </div>

        {/* Scope + install path row */}
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div
            style={{
              display: "flex",
              borderRadius: 5,
              border: "1px solid var(--border)",
              overflow: "hidden",
              fontSize: 12,
              flexShrink: 0,
            }}
          >
            {(["global", "project"] as const).map((s) => (
              <button
                key={s}
                onClick={() => setScope(s)}
                style={{
                  padding: "3px 10px",
                  border: "none",
                  cursor: "pointer",
                  background: scope === s ? "var(--bg-selected)" : "none",
                  color: scope === s ? "var(--text)" : "var(--text-dim)",
                  fontWeight: scope === s ? 600 : 400,
                  borderRight:
                    s === "global" ? "1px solid var(--border)" : "none",
                }}
              >
                {s === "global" ? "全局" : "项目"}
              </button>
            ))}
          </div>
          <span
            style={{
              fontSize: 12,
              color: "var(--text-dim)",
              fontFamily: "var(--font-mono)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            → {installPath}
          </span>
        </div>

        {/* Errors */}
        {searchError && (
          <div style={{ fontSize: 12, color: "#f87171" }}>{searchError}</div>
        )}
        {installError && (
          <div
            style={{ fontSize: 12, color: "#f87171", wordBreak: "break-word" }}
          >
            {installError}
          </div>
        )}
      </div>

      {/* ── Upload zip ── */}
      <div
        onDrop={onDropZip}
        onDragOver={(e) => e.preventDefault()}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          marginBottom: 16,
          padding: "10px 12px",
          border: "1px dashed var(--border)",
          borderRadius: 6,
          background: "var(--bg-panel)",
        }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="17 8 12 3 7 8" />
          <line x1="12" y1="3" x2="12" y2="15" />
        </svg>
        <span style={{ fontSize: 12, color: "var(--text-muted)", flex: 1 }}>
          拖入技能 zip 包，或
        </span>
        <input
          ref={fileInputRef}
          type="file"
          accept=".zip"
          style={{ display: "none" }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) uploadZip(f);
            e.target.value = "";
          }}
        />
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={zipBusy}
          style={{
            padding: "5px 14px",
            fontSize: 12,
            fontWeight: 500,
            borderRadius: 5,
            border: "1px solid var(--border)",
            cursor: zipBusy ? "not-allowed" : "pointer",
            background: "none",
            color: zipBusy ? "var(--text-dim)" : "var(--text-muted)",
            flexShrink: 0,
          }}
        >
          {zipBusy ? "安装中…" : "选择 zip"}
        </button>
        {zipDone && (
          <span style={{ fontSize: 12, color: "#16a34a", flexShrink: 0 }}>
            ✓ {zipDone}
          </span>
        )}
      </div>
      {zipError && (
        <div style={{ fontSize: 12, color: "#f87171", marginBottom: 12, wordBreak: "break-word" }}>
          {zipError}
        </div>
      )}

      {/* ── Results list ── */}
      {results.length > 0 ? (
        <div style={{ flex: 1, overflowY: "auto" }}>
          {results.map((r) => {
            const isInstalled = installedPkgs.has(r.package);
            const isInstalling = installing === r.package;
            // split "owner/repo@skill" for cleaner display
            const atIdx = r.package.indexOf("@");
            const repopart = atIdx > -1 ? r.package.slice(0, atIdx) : r.package;
            const skillpart = atIdx > -1 ? r.package.slice(atIdx + 1) : null;
            return (
              <div
                key={r.package}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 14,
                  padding: "12px 0",
                  borderBottom: "1px solid var(--border)",
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  {/* skill name prominent */}
                  <div
                    style={{
                      fontSize: 13,
                      fontWeight: 600,
                      color: "var(--text)",
                      marginBottom: 3,
                    }}
                  >
                    {skillpart ?? repopart}
                  </div>
                  {/* repo + installs + link row */}
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      flexWrap: "wrap",
                    }}
                  >
                    <span
                      style={{
                        fontFamily: "var(--font-mono)",
                        fontSize: 11,
                        color: "var(--text-dim)",
                      }}
                    >
                      {repopart}
                    </span>
                    <span
                      style={{
                        fontSize: 12,
                        color: "var(--text-muted)",
                        fontWeight: 500,
                      }}
                    >
                      {r.installs}
                    </span>
                    {r.url && (
                      <a
                        href={r.url}
                        target="_blank"
                        rel="noreferrer"
                        style={{
                          fontSize: 12,
                          color: "var(--accent)",
                          textDecoration: "none",
                        }}
                      >
                        skills.sh ↗
                      </a>
                    )}
                  </div>
                </div>
                <button
                  onClick={() =>
                    !isInstalled && !isInstalling && install(r.package)
                  }
                  disabled={isInstalled || isInstalling || installing !== null}
                  style={{
                    flexShrink: 0,
                    padding: "5px 14px",
                    fontSize: 12,
                    fontWeight: 500,
                    borderRadius: 5,
                    border: "1px solid var(--border)",
                    cursor:
                      isInstalled || isInstalling || installing !== null
                        ? "not-allowed"
                        : "pointer",
                    background: isInstalled ? "rgba(34,197,94,0.1)" : "none",
                    color: isInstalled
                      ? "#16a34a"
                      : isInstalling
                        ? "var(--accent)"
                        : "var(--text-muted)",
                    transition: "color 0.12s",
                  }}
                >
                  {isInstalled
                    ? "✓ 已安装"
                    : isInstalling
                      ? "安装中…"
                      : "安装"}
                </button>
              </div>
            );
          })}
        </div>
      ) : (
        !searchError &&
        !searching && (
          <div
            style={{ fontSize: 13, color: "var(--text-dim)", lineHeight: 1.8 }}
          >
            在{" "}
            <a
              href="https://skills.sh"
              target="_blank"
              rel="noreferrer"
              style={{ color: "var(--accent)", textDecoration: "none" }}
            >
              skills.sh
            </a>{" "}
            上搜索并为你的智能体安装技能。
          </div>
        )
      )}
    </div>
  );
}

export function SkillsConfig({
  cwd,
  onClose,
}: {
  cwd: string;
  onClose: () => void;
}) {
  const isMobile = useIsMobile();
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [toggling, setToggling] = useState<Set<string>>(new Set());
  const [saveError, setSaveError] = useState<string | null>(null);
  const [addMode, setAddMode] = useState(false);

  const loadSkills = useCallback(() => {
    setLoading(true);
    setError(null);
    fetch(`/api/skills?cwd=${encodeURIComponent(cwd)}`)
      .then((r) => r.json())
      .then((d: { skills?: Skill[]; error?: string }) => {
        if (d.error) {
          setError(d.error);
          return;
        }
        const list = d.skills ?? [];
        setSkills(list);
        if (list.length > 0 && !selected) setSelected(list[0].filePath);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [cwd, selected]);

  useEffect(() => {
    loadSkills();
  }, [cwd]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = useCallback(async (skill: Skill) => {
    const next = !skill.disableModelInvocation;
    setToggling((s) => new Set(s).add(skill.filePath));
    setSaveError(null);
    try {
      const res = await fetch("/api/skills", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filePath: skill.filePath,
          disableModelInvocation: next,
        }),
      });
      const d = (await res.json()) as { success?: boolean; error?: string };
      if (!res.ok || d.error) {
        setSaveError(d.error ?? `HTTP ${res.status}`);
        return;
      }
      setSkills((prev) =>
        prev.map((s) =>
          s.filePath === skill.filePath
            ? { ...s, disableModelInvocation: next }
            : s,
        ),
      );
    } catch (e) {
      setSaveError(String(e));
    } finally {
      setToggling((s) => {
        const n = new Set(s);
        n.delete(skill.filePath);
        return n;
      });
    }
  }, []);

  const selectedSkill = skills.find((s) => s.filePath === selected) ?? null;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        background: "rgba(0,0,0,0.35)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          width: isMobile ? "calc(100vw - 16px)" : 860,
          maxWidth: "calc(100vw - 16px)",
          height: isMobile ? "calc(100dvh - 16px)" : "78vh",
          maxHeight: "calc(100dvh - 16px)",
          background: "var(--bg)",
          border: "1px solid var(--border)",
          borderRadius: 10,
          display: "flex",
          flexDirection: "column",
          boxShadow: "0 8px 32px rgba(0,0,0,0.18)",
          overflow: "hidden",
        }}
      >
        {/* Header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "12px 18px",
            borderBottom: "1px solid var(--border)",
            flexShrink: 0,
          }}
        >
          <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
            <span
              style={{ fontSize: 15, fontWeight: 700, color: "var(--text)" }}
            >
              技能
            </span>
            <code
              style={{
                fontSize: 11,
                color: "var(--text-muted)",
                fontFamily: "var(--font-mono)",
                maxWidth: 320,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {shortenPath(cwd)}
            </code>
          </div>
          <button
            onClick={onClose}
            style={{
              background: "none",
              border: "none",
              color: "var(--text-muted)",
              cursor: "pointer",
              fontSize: 20,
              lineHeight: 1,
              padding: "2px 6px",
            }}
          >
            ×
          </button>
        </div>

        {/* Body */}
        <div style={{ flex: 1, display: "flex", flexDirection: isMobile ? "column" : "row", overflow: "hidden" }}>
          {/* Left: skill list */}
          <div
            style={{
              width: isMobile ? "100%" : 210,
              maxHeight: isMobile ? "40vh" : undefined,
              borderRight: isMobile ? "none" : "1px solid var(--border)",
              borderBottom: isMobile ? "1px solid var(--border)" : "none",
              display: "flex",
              flexDirection: "column",
              flexShrink: 0,
              background: "var(--bg-panel)",
            }}
          >
            <div style={{ flex: 1, overflowY: "auto", padding: "8px 6px" }}>
              {loading ? (
                <div
                  style={{
                    padding: "10px 8px",
                    fontSize: 12,
                    color: "var(--text-muted)",
                  }}
                >
                  加载中…
                </div>
              ) : error ? (
                <div
                  style={{
                    padding: "10px 8px",
                    fontSize: 11,
                    color: "#f87171",
                  }}
                >
                  {error}
                </div>
              ) : skills.length === 0 ? (
                <div
                  style={{
                    padding: "10px 8px",
                    fontSize: 11,
                    color: "var(--text-dim)",
                  }}
                >
                  未找到技能
                </div>
              ) : (
                (() => {
                  const groups: { label: string; skills: typeof skills }[] = [];
                  for (const grpLabel of ["project", "global", "path"]) {
                    const grpSkills = skills.filter(
                      (s) => sourceLabel(s) === grpLabel,
                    );
                    if (grpSkills.length > 0)
                      groups.push({ label: grpLabel, skills: grpSkills });
                  }
                  return groups.map(
                    ({ label: grpLabel, skills: grpSkills }) => (
                      <div key={grpLabel} style={{ marginBottom: 6 }}>
                        <div
                          style={{
                            padding: "4px 8px 3px",
                            fontSize: 10,
                            fontWeight: 600,
                            color: "var(--text-dim)",
                            textTransform: "uppercase",
                            letterSpacing: "0.06em",
                          }}
                        >
                          {grpLabel === "project"
                            ? "项目"
                            : grpLabel === "global"
                              ? "全局"
                              : "路径"}
                        </div>
                        {grpSkills.map((skill) => {
                          const isSelected =
                            !addMode && selected === skill.filePath;
                          const disabled = skill.disableModelInvocation;
                          return (
                            <div
                              key={skill.filePath}
                              onClick={() => {
                                setSelected(skill.filePath);
                                setAddMode(false);
                              }}
                              style={{
                                display: "flex",
                                alignItems: "center",
                                gap: 7,
                                padding: "8px 8px",
                                borderRadius: 5,
                                cursor: "pointer",
                                background: isSelected
                                  ? "var(--bg-selected)"
                                  : "none",
                              }}
                              onMouseEnter={(e) => {
                                if (!isSelected)
                                  e.currentTarget.style.background =
                                    "var(--bg-hover)";
                              }}
                              onMouseLeave={(e) => {
                                if (!isSelected)
                                  e.currentTarget.style.background = "none";
                              }}
                            >
                              <span
                                style={{
                                  flexShrink: 0,
                                  width: 7,
                                  height: 7,
                                  borderRadius: "50%",
                                  background: disabled
                                    ? "var(--border)"
                                    : "var(--accent)",
                                  boxShadow: disabled
                                    ? "none"
                                    : "0 0 4px var(--accent)",
                                  transition:
                                    "background 0.15s, box-shadow 0.15s",
                                }}
                              />
                              <span
                                style={{
                                  fontSize: 12,
                                  fontWeight: isSelected ? 600 : 400,
                                  color: disabled
                                    ? "var(--text-dim)"
                                    : "var(--text)",
                                  fontFamily: "var(--font-mono)",
                                  flex: 1,
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                  whiteSpace: "nowrap",
                                }}
                              >
                                {skill.name}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    ),
                  );
                })()
              )}
            </div>
            {/* Add skill button */}
            <div
              style={{
                padding: "8px 6px",
                borderTop: "1px solid var(--border)",
                flexShrink: 0,
              }}
            >
              <div
                onClick={() => setAddMode(true)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "7px 8px",
                  borderRadius: 5,
                  cursor: "pointer",
                  background: addMode ? "var(--bg-selected)" : "none",
                  color: addMode ? "var(--accent)" : "var(--text-dim)",
                  fontSize: 12,
                }}
                onMouseEnter={(e) => {
                  if (!addMode)
                    e.currentTarget.style.background = "var(--bg-hover)";
                }}
                onMouseLeave={(e) => {
                  if (!addMode) e.currentTarget.style.background = "none";
                }}
              >
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
                添加技能
              </div>
            </div>
          </div>

          {/* Right: detail or add panel */}
          <div style={{ flex: 1, overflowY: "auto", padding: 20 }}>
            {addMode ? (
              <AddSkillPanel
                cwd={cwd}
                onInstalled={() => {
                  loadSkills();
                }}
              />
            ) : loading ? null : selectedSkill ? (
              <SkillDetail
                key={selectedSkill.filePath}
                skill={selectedSkill}
                cwd={cwd}
                onToggle={toggle}
                toggling={toggling.has(selectedSkill.filePath)}
                saveError={saveError}
              />
            ) : (
              <div
                style={{
                  height: "100%",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "var(--text-dim)",
                  fontSize: 13,
                }}
              >
                选择一个技能
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "flex-end",
            padding: "10px 18px",
            borderTop: "1px solid var(--border)",
            flexShrink: 0,
          }}
        >
          <button
            onClick={onClose}
            style={{
              padding: "6px 14px",
              background: "none",
              border: "1px solid var(--border)",
              borderRadius: 6,
              color: "var(--text-muted)",
              cursor: "pointer",
              fontSize: 13,
            }}
          >
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
