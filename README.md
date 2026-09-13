# pi-web

[中文文档](./README.zh-CN.md)

Local web UI for the [pi coding agent](https://github.com/badlogic/pi-mono). pi-web reads your local pi session files and gives you a browser workspace for session browsing, real-time chat, model configuration, skill management, and project file preview.

The same pi session in CLI and pi-web: structured tool calls, readable Markdown, session browsing, and cleaner results.

This project is a UI/UX redesign and desktop adaptation based on the original version by @agegr. Original project: [pi-web original version](https://github.com/agegr/pi-web)


## Desktop app (Windows)

This fork also builds into a standalone Windows desktop application — no Node.js or pi CLI install required. The pi coding engine and all LLM provider SDKs are bundled inside the `.exe`.

**Build it yourself:**

```bash
npm install
npm run desktop:build
```

This runs `next build` (standalone output) and then `electron-builder`, producing `dist-electron/Pi Agent Setup <version>.exe` — an NSIS installer that installs per-user (no admin prompt) to `%LOCALAPPDATA%\Programs\Pi Agent`.

**First run:** the app seeds `~/.pi/agent/models.json` (DeepSeek only, with `$DEEPSEEK_API_KEY` placeholder) and `settings.json` if they do not already exist. The only thing you need to do is open the Models panel and enter a DeepSeek API key — then start chatting.

**Coexistence with the pi CLI:** the desktop app shares the same data directory (`~/.pi/agent`) as the pi CLI. If you already use pi, the desktop app inherits your existing config, API keys, and session history — nothing is overwritten. Both can even run at the same time (they use different ports). If you prefer isolation, set `PI_CODING_AGENT_DIR` to a separate directory before launching.

**Notes:**
- Target: Windows 10 x64 (1909+ recommended). Not code-signed, so SmartScreen will warn on first install — click "More info → Run anyway".
- No auto-update in this version; rerun `npm run desktop:build` and reinstall to upgrade.
- Dev mode (hot reload): `npm run desktop:dev` — spawns `next dev` and an Electron window together.

**Troubleshooting (if the app won't start):**

- **Antivirus quarantines a file / blank window on launch.** Pi Agent ships its own Node 22 runtime at `resources/node/node.exe` and runs the UI server as a child process. Some antivirus products (Windows Defender, 360, Huorong) flag a `node.exe` launched from the user's `AppData` as suspicious and may quarantine it. If the app opens to a blank/error page, check your antivirus quarantine and restore or whitelist `node.exe` (and the install folder). This is a known cost of shipping an unsigned app.
- **"Windows protected your PC" (SmartScreen).** This appears on first run because the installer is not code-signed. Click **More info → Run anyway**. You only need to do this once per version; the app remembers the trust.
- **Slow first launch.** The first start can take 10–30s while the bundled server warms up (and longer if antivirus is scanning it in real time). If it exceeds ~45s the app shows a retry page — click **Retry**.
- **Port is dynamic.** The app picks a free loopback port (`127.0.0.1`) at startup, so it never conflicts with other services and never triggers a firewall prompt.

**Building from source / pitfalls:** see [docs/desktop-build.md](./docs/desktop-build.md) for the full build flow, the role of each file under `desktop/`, and the real pitfalls hit during packaging and distribution (EPERM tracing, electron-builder `files` quirks, the bundled Node 22 runtime, antivirus false positives, etc.).

## Desktop app (macOS)

Same architecture as the Windows build — a standalone desktop app, no Node.js or pi CLI install required. It produces **two `.dmg` files**; pick the one matching your CPU:

| File | Machines |
|------|----------|
| `Pi Agent-<version>-arm64.dmg` | Apple Silicon (M1/M2/M3/M4, late 2020 onward) |
| `Pi Agent-<version>-x64.dmg` | Intel Mac (pre-2020) |

**Build it yourself (must run on macOS):**

```bash
npm install
npm run desktop:icon        # generates icon.ico + icon.icns (iconutil is macOS-only)
npm run desktop:build:mac   # produces dist-electron/Pi Agent-<version>-{arm64,x64}.dmg
```

On an Apple Silicon Mac one run produces both dmgs (electron-builder cross-packages the x64 one); an Intel Mac can only produce x64.

**First launch (important):** the app is not code-signed or notarized, so Gatekeeper will block it. Either:

1. Mount the dmg and drag `Pi Agent` to Applications, then **right-click → Open** it (not a double-click) in Applications and confirm **Open** in the dialog. You only need to do this once.
2. Or clear the quarantine attribute from the command line:

   ```bash
   xattr -rd com.apple.quarantine "/Applications/Pi Agent.app"
   ```

If macOS says the app is **“damaged and can't be opened”**, the bundle is missing a valid ad-hoc signature — run:

```bash
codesign --force --deep --sign - "/Applications/Pi Agent.app"
```

(The normal build already ad-hoc signs the bundle via `desktop/after-pack-sign.cjs`; re-sign manually only after modifying the `.app`.)

**Notes:**

- Shares `~/.pi/agent` with the pi CLI and seeds `models.json` / `settings.json` on first run (skipped if they already exist).
- Distributed unsigned. For true double-click launch you need an Apple Developer account ($99/yr) for Developer ID signing + notarization.
- Features that shell out to git / npm / npx (worktrees, skill/plugin install): the app appends Homebrew, `/usr/local/bin` and `~/.local/bin` to the child process PATH. If your node lives under nvm/fnm/asdf, configure those in your shell.
- Dev mode (hot reload): `npm run desktop:dev`, with the same limitations as the Windows build (see the build docs).

**Building from source / pitfalls (macOS):** see [docs/desktop-build-mac.zh-CN.md](./docs/desktop-build-mac.zh-CN.md) (Chinese) — covers npm 12's `allow-remote` / install-script blocks, the `/Users/**` trace-exclusion trap, arm64 ad-hoc signing, and more.

## Features

- **Pick work back up**: browse previous pi conversations by project without digging through terminal history or session paths.
- **Try different directions safely**: continue from an earlier message or fork a session into a separate route.
- **Work across branches**: switch Git worktrees from the sidebar so new sessions and the Explorer follow the checkout you choose.
- **Chat beside the project**: browse files on the left and preview source, docs, images, audio, and PDFs on the right while the agent works.
- **See session state clearly**: context usage, cost, compaction state, and system prompt details are visible from the top bar.
- **Configure less from the terminal**: manage models, login/API keys, model tests, and skill switches from the web UI.

## Customizations (this fork)

This fork keeps all upstream features and adds the following changes:

- **Universal file upload**: the upload button (➕) now accepts any file format, not just images. Uploaded files are written to `uploads/` under the session working directory, named `<timestamp>-<sha256[16]>-<original-name>`, and inserted into the input box as `@uploads/<name>` mentions. The agent reads them via its normal `@path` mechanism, so the previous inline base64 / `images` pipeline has been removed entirely — images go through the same path.
- **New `/api/uploads` route**: multipart endpoint that lands files in `${cwd}/uploads/` (25 MB per file) and returns the cwd-relative paths for `@` insertion.
- **Branch button relocated**: the Branch button moved from the top bar to the input bar controls (between Session Info and System); opening it still uses the top drawer like Session Info and System.
- **Sound button repositioned** to the far right of the controls.
- **Branding simplified**: the logo/title is `Pi Agent` everywhere (the `Web` suffix and the `web/pi` version numbers on the welcome screen were removed).
- **Welcome screen**: shows a random encouraging line above the input box.
- **Input box hints**: placeholder now notes `Enter` to send, `Shift+Enter` for a newline; the Send button is icon-only (the "Send" label was removed).
- **Popup layering fix**: slash-command and `@file` menus now use `position: fixed` so they are no longer clipped/covered by the top bar on the welcome screen.
- **Worktree switcher hidden**: the sidebar Git worktree switcher and its "Git repository root only" hint are hidden in the UI via a `WORKTREE_UI_HIDDEN` flag (`components/SessionSidebar.tsx`). The underlying logic is intact — flip the flag to `false` to bring it back.

### New in 0.8.0

- **Excel preview**: `.xlsx` / `.xlsm` files are rendered as HTML tables via SheetJS (`xlsx`), one table per sheet.
- **Legacy binary doc prompt**: old binary formats (`.doc` / `.xls` / `.ppt` / `.rtf` / ...) no longer render as garbled text — a friendly notice is shown that guides to "Open locally" (desktop only). Detection: `isLegacyBinaryDocument` in `lib/file-types.ts`.
- **Open locally**: a button next to Download opens the current file with its OS default application (desktop only; hidden in browser). IPC: `piDesktop.openFile` → `shell.openPath`, with UNC-path and control-char filtering.
- **Open in file manager**: a folder icon next to the file-tree refresh button opens the current project root (cwd) in the OS file manager (desktop only; hidden in browser).
- **Close all preview tabs**: a "✕ close all" button at the right of the preview tab bar closes every preview tab at once and collapses the right panel.
- **Skill zip upload**: "Skills → Add" accepts a skill zip — supports `SKILL.md` at the archive root or inside a single subdir, errors on name conflict, and includes path-traversal + zip-bomb protection (`lib/skill-zip.ts`: 10 MB/file, 50 MB total, 2000 entries max).
- **Multi-file upload fix**: selecting multiple files in the input box used to show only one path; all paths are now inserted correctly.
- **Browse local folder**: the project-directory dropdown has a new "Browse local folder…" entry that opens the OS native directory picker (desktop only; browsers can't read a real disk path from a picker so the button is hidden — the manual "Custom path…" entry still works).
- **Auto session naming**: after the first round of a brand-new session (your message + the AI reply), the current model summarizes a title of 20 chars or fewer and updates the sidebar list. Sessions you've renamed or that already have a title are never overwritten; if summarization fails, the title is left unchanged (silent, no error).
- **Compact skill display**: a skill invoked in a user message (`/skill:XXX`) no longer renders the entire SKILL.md inline — it collapses into a `skill:XXX` link that opens the full SKILL.md in the preview drawer (and can be expanded inline). The full skill text is still sent to the agent, so nothing functional changes.

## Notes

- **Data directory**: pi-web reads `~/.pi/agent/sessions` by default. Set `PI_CODING_AGENT_DIR` to point at another pi agent directory.
- **Session files**: files are stored as `~/.pi/agent/sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl`.
- **Model config**: the Models panel reads and writes `models.json` in the pi agent directory. Model lists and defaults come from pi's config.
- **File access**: file browsing and preview are scoped to the selected project directory and working directories that appear in sessions.
- **Git worktrees**: see [Worktrees in pi-web](./docs/worktrees.md) for when the switcher appears, how new worktrees are created, and what removal does.
- **Forks vs in-session branches**: Fork creates a new `.jsonl` file. "Edit from here" creates another branch inside the same session file.

## Development

```bash
npm install
npm run dev
```

The local dev server runs at [http://localhost:30141](http://localhost:30141).

Common checks:

```bash
node_modules/.bin/tsc --noEmit
npm run lint
```

Avoid running `next build` / `npm run build` during local development. It writes to `.next/` and can interfere with the dev server; leave builds for release work.

## Project Structure

```text
app/
  api/
    agent/          # creates/drives AgentSession and exposes SSE events
    auth/           # OAuth and API key management
    cwd/validate/   # custom working directory validation
    default-cwd/    # pi default working directory lookup
    files/          # file listing, reading, preview, and watching
    home/           # current user home directory
    models/         # available models, default model, thinking levels
    models-config/  # read/write models.json and test models
    sessions/       # session reads, rename, delete, context, HTML export
    skills/         # skill listing, search, install, enable/disable
    uploads/        # multipart file upload, writes to ${cwd}/uploads/
components/
  AppShell.tsx        # main layout, URL state, top panels, file tabs
  SessionSidebar.tsx  # project selector, session tree, Explorer
  ChatWindow.tsx      # messages, SSE, file drag/drop, minimap
  ChatInput.tsx       # input bar, file upload, model/tools/thinking/compact/slash controls
  MessageView.tsx     # message, thinking, tool call/result rendering
  ModelsConfig.tsx    # model and auth configuration panel
  SkillsConfig.tsx    # skill management panel
  FileExplorer.tsx    # file tree
  FileViewer.tsx      # source, diff, image, audio, PDF, DOCX preview
lib/
  rpc-manager.ts      # AgentSessionWrapper lifecycle and global registry
  session-reader.ts   # parses .jsonl session files and branch contexts
  normalize.ts        # normalizes toolCall field names
  file-access.ts      # file read safety boundary
  file-paths.ts       # path encoding and relative path helpers
  markdown.ts         # Markdown/Mermaid/KaTeX plugin configuration
  pi-types.ts         # pi-related types
hooks/
  useAgentSession.ts  # session loading, command sending, SSE state machine
  useAudio.ts         # completion sound
  useDragDrop.ts      # image drag/drop
  useTheme.ts         # theme switching
bin/
  pi-web.js           # npm CLI entrypoint
```
