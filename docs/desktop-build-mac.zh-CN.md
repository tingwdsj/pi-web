# 桌面端打包说明（macOS）

本文档面向**想自己从源码打包 Pi Agent macOS 桌面版**的人，记录打包流程、与 Windows 版的差异，以及 Mac 上真实踩过的坑。Windows 版的完整踩坑记录见 [`desktop-build.zh-CN.md`](./desktop-build.zh-CN.md)，两版**共用同一套架构**，本文只讲 Mac 特有/平台化的部分。

> 早期设计文档见 [`desktop-mac-plan.zh-CN.md`](./desktop-mac-plan.zh-CN.md)（已实施，保留作背景参考）。
> 构建配置在 `desktop/electron-builder.yml`，代码在 `desktop/`。

---

## 1. 架构一览（与 Windows 版相同）

Pi Agent 桌面版 = **Electron 外壳 + 内置 Next.js standalone 服务 + 内置 Node 22 运行时**。

```
Pi Agent.app（Electron 主进程，main.cjs）
  ├─ 首次启动：seed ~/.pi/agent/{models.json, settings.json}（已存在则跳过）
  ├─ 挑一个空闲 loopback 端口
  ├─ spawn Resources/node/node 跑 Resources/server/server.js（Next standalone）
  ├─ 轮询 /api/home 直到 200
  └─ BrowserWindow 加载 http://127.0.0.1:<port>/
```

安装后布局（`/Applications/Pi Agent.app/Contents/Resources`）：

```
Resources/
  app/                 ← Electron 应用包（asar 关闭）
    main.cjs           ← 主进程入口
    preload.cjs
    lib/               ← port.cjs / seed.cjs / spawn.cjs
    seed-models.json   ← 首次 seed 用的 DeepSeek 模板
    seed-settings.json
    icon.icns / icon.ico
    package.json       ← main: main.cjs
  server/              ← Next.js standalone（自带 node_modules）
    server.js
    .next/static/
    node_modules/@earendil-works/...   ← pi SDK + LLM SDK
  node/
    node               ← Node 22 运行时（~104 MB，darwin-arm64 或 darwin-x64）
```

产物（`dist-electron/`）：

| 文件 | 适用机器 |
|------|----------|
| `Pi Agent-<version>-arm64.dmg` | Apple Silicon（M1/M2/M3/M4，2020 年底起） |
| `Pi Agent-<version>-x64.dmg` | Intel Mac（2020 年前） |

---

## 2. 打包步骤

### 前置

- **macOS 主机**。electron-builder 不能交叉打 Mac 包（不像 Windows 能在 Linux 上打）。
  - 在 **Apple Silicon** Mac 上可同时产出 arm64 + x64 两个 dmg（electron-builder 会交叉打 x64）。
  - Intel Mac 只能产 x64。
- Node 18+（用于跑 `next build` / `electron-builder`，与内置运行时无关）。
- 已 `npm install`。

### 一键打包

```bash
npm install                # 见「坑 M1/M2」：npm 12 需要额外放行
npm run desktop:icon       # 生成 desktop/icon.ico + desktop/icon.icns（iconutil 需要 macOS）
npm run desktop:build:mac  # fetch-node → next build → nft 补齐 → electron-builder --mac
```

`desktop:build:mac` 等价于：

```bash
# 1. 下载当前平台/架构的 Node 22 到 desktop/node-runtime/node（已存在则跳过）
node desktop/fetch-node.cjs

# 2. Next 生产构建（standalone 输出 + 文件追踪）
cross-env NODE_OPTIONS="--require ./desktop/win-eperm-patch.cjs" next build --webpack

# 3. 补齐 nft 漏追踪的运行时资源（pi CLI / 导出模板 / 第三方依赖）
node desktop/ensure-standalone-chunks.cjs

# 4. electron-builder 打两个 dmg
electron-builder --config desktop/electron-builder.yml --mac
```

> `desktop:build`（不带 `:mac`）在 Mac 上也等价——默认就按当前平台构建。`desktop:build:mac` 只是显式传 `--mac`，避免误触 Windows 目标。

### 只出一个架构（可选）

临时改 `desktop/electron-builder.yml` 的 `mac.target[0].arch`，或命令行：

```bash
npx electron-builder --config desktop/electron-builder.yml --mac --arm64
npx electron-builder --config desktop/electron-builder.yml --mac --x64
```

### 开发模式（热重载）

```bash
npm run desktop:dev
```

与 Windows 版一样有局限：dev 模式跑在 Electron 内置 Node 20.18 上，碰 pi SDK 的接口会报 `markAsUncloneable`。**只适合纯前端 UI 调试**，涉及 pi SDK 的功能必须完整打包后实测。

---

## 3. 平台化的文件（相对 Windows 版改了哪些）

架构层完全平台无关，改动集中在以下几处：

| 文件 | 改了什么 |
|------|----------|
| `desktop/fetch-node.cjs` | **重写为跨平台**：按 `process.platform`/`process.arch` 选 `node-v22.14.0-<os>-<arch>.{zip,tar.gz}`；Windows 走手写 ZIP 解析器，macOS/Linux 走系统 `tar` 解出 `bin/node`，输出文件名 `node.exe`（Win）/ `node`（Mac），非 Win 显式 `chmod 0o755` |
| `desktop/electron-builder.yml` | 新增 `mac:` 段（dmg、arm64+x64、icon.icns、`identity: null`）、`dmg:` 拖拽布局；`extraResources` 的 node 项从硬编码 `node.exe` 改为 `from: desktop/node-runtime` + `filter: ["node*"]`；`files` 过滤排除 `node-runtime/**`（避免 80MB 二进制在 `resources/app` 里重复一份）；新增 `afterPack: desktop/after-pack-sign.cjs` |
| `desktop/after-pack-sign.cjs` | **新增**：打包后用 `codesign --force --deep --sign -` 给 `.app` 做 ad-hoc 签名（见「坑 M4」） |
| `desktop/main.cjs` | nodePath 按平台取 `node`/`node.exe`；窗口图标按平台取 `icon.icns`/`icon.ico`；错误页文案区分平台；**macOS 保留一份基于 role 的应用菜单**（否则删掉菜单会连带删掉 Cmd+C/V/Q/W 快捷键）；新增 `activate` 处理（点 Dock 图标重开窗口，复用同一端口，不重启服务） |
| `desktop/lib/spawn.cjs` | 环境变量白名单补 `HOME` / `SHELL` / `USER` / `LOGNAME` / `XDG_*` / `SSH_AUTH_SOCK` 等；macOS 下自动把 `/opt/homebrew/bin`、`/usr/local/bin`、`~/.local/bin`（存在时）追加进 `PATH`——Finder 启动的 App 只有 launchd 的最小 PATH |
| `desktop/make-icon.mjs` | 原来只出 `.ico`；现在 `darwin` 下额外渲染各尺寸 PNG 到临时 `.iconset`，调 `iconutil -c icns` 生成 `desktop/icon.icns` |
| `next.config.ts` | `outputFileTracingExcludes` 改为按平台：**POSIX 上不再排除 `/Users/**`、`/home/**`**（见「坑 M3」） |
| `.gitignore` | 忽略整个 `desktop/node-runtime/`（原来只忽略 `node.exe`） |
| `.npmrc` | 新增 `replace-registry-host=always`（见「坑 M1」） |
| `package.json` | 新增 `desktop:build:mac`；新增 `allowScripts`（见「坑 M2」） |

不用动（已确认平台无关）：`desktop/lib/port.cjs`、`desktop/lib/seed.cjs`（用 `os.homedir()`）、`desktop/preload.cjs`、`desktop/ensure-standalone-chunks.cjs`、`desktop/skip-deps.js`、`desktop/lib/spawn.cjs` 的 `killTree`（非 Win 走 SIGTERM）。

---

## 4. 打包时可能遇到的坑（Mac 特有）

### 坑 M1：npm 12 拒绝 lockfile 里的镜像 tarball（`EALLOWREMOTE`）

**现象**：

```
npm error code EALLOWREMOTE
npm error Fetching packages of type "remote" have been disabled
npm error Refusing to fetch "zip-stream@https://registry.npmmirror.com/zip-stream/-/zip-stream-4.1.1.tgz"
```

**原因**：npm 12 默认 `allow-remote=none`。`package-lock.json` 里部分 `resolved` 指向 `registry.npmmirror.com`，与当前 registry（`registry.npmjs.org`）不同源，npm 就把它归类为「remote tarball」并拒绝。

**对策**（已实装）：项目 `.npmrc` 加

```ini
replace-registry-host=always
```

npm 会把所有 `resolved` 的 host 重写成当前 registry，于是它们变回普通 registry 抓取。装完 npm 可能顺带把 `package-lock.json` 里的 `resolved` 规范化为当前 registry，属正常。

> 如在国内想更快，可再给项目加 `registry=https://registry.npmmirror.com/`；两条配置一起用即可全部走镜像。

### 坑 M2：npm 12 默认阻止依赖的 install 脚本

**现象**：`npm install` 成功，但 `node_modules/electron/dist/` 是空的、`node_modules/electron/path.txt` 为空，`electron` 跑不起来。日志末尾：

```
npm warn install-scripts 7 packages had install scripts blocked because they are not covered by allowScripts:
npm warn install-scripts   electron@33.4.11 (postinstall: node install.js)
npm warn install-scripts   sharp@0.34.5 (install: node install/check.js || npm run build)
...
```

**原因**：npm 12 默认不跑依赖的 `preinstall`/`install`/`postinstall`。`electron` 正是靠 `postinstall: node install.js` 从镜像下载 Electron 二进制；`sharp` 靠 install 脚本就位原生库。

**对策**（已实装）：放行本项目实际需要的脚本，写入 `package.json` 的 `allowScripts`：

```bash
npm install-scripts approve electron sharp protobufjs unrs-resolver @google/genai
```

如果 `npm install` 之后才发现脚本被拦（包已解包、npm 不会自动重跑），执行：

```bash
npm rebuild electron      # 或 npm rebuild（全部）
```

验证：

```bash
cat node_modules/electron/path.txt
# 期望：Electron.app/Contents/MacOS/Electron
```

> 换机器/换 npm 版本时，`npm install-scripts ls` 可查看还有哪些脚本被拦。
> 若用 npm ≤ 11，此机制不存在，install 脚本会正常执行，可忽略本坑。

### 坑 M3：`/Users/**` 追踪排除会把项目自己的依赖全排掉（**Mac 专用地雷**）

**现象**：`next build` 成功，但 `.next/standalone` 只有几十 MB 甚至几 MB，里面缺 `node_modules/next`、缺 `@earendil-works/*`；打包后启动白屏，服务端报 `Cannot find module 'next'` / pi SDK 相关 500。

**原因**：`next.config.ts` 原来的 `outputFileTracingExcludes` 含 `"/Users/**"` 和 `"/home/**"`。Next 用 `picomatch(..., { contains: true })` 拿这些 glob 去匹配**绝对路径**；而 mac/Linux 上项目通常就在 `/Users/<你>/...` 下，于是**项目内每一个被追踪的文件都被判定为「该忽略」**，standalone 于是没有依赖。

Windows 版没暴露这个问题，是因为它的排除项是 `C:\Users\**` 等，且那台构建机的项目不在 `C:\Users` 下。

**对策**（已实装）：`next.config.ts` 改为按平台构造排除列表——Windows 保留 `C:\Users\**` / `C:\Program Files\**` / `C:\Program Files (x86)\**`（用于规避 nft 追踪时误入受保护目录的 EPERM），**POSIX 上不设任何绝对路径排除**（项目外的绝对路径本来就会被 Next 的 ignore 函数忽略，不需要再排）。

**自检**：构建后

```bash
du -sh .next/standalone
ls .next/standalone/node_modules/@earendil-works
```

期望 ≥ 100 MB 且能看到 `pi-ai`、`pi-coding-agent`。若明显偏小或目录不存在，就是踩了这个坑。

### 坑 M4：arm64 未签名 App 在别的机器上被报「已损坏」

**现象**：本机跑正常，把 dmg 发给别人（或下载后打开），macOS 弹「“Pi Agent”已损坏，无法打开，你应该将它移到废纸篓」。右键 → 打开也无效。

**原因**：Apple Silicon 要求所有 arm64 可执行文件至少有有效签名。Electron 上游二进制自带 ad-hoc 签名，但我们重新打包（写入 resources）后外层 `.app` 的签名失效；下载又会给 dmg 打上 quarantine 属性，Gatekeeper 于是判定「已损坏」而不是较友好的「身份不明的开发者」。

**对策**（已实装）：`desktop/electron-builder.yml` 设 `mac.identity: null` 关闭 electron-builder 的证书签名，新增 `afterPack: desktop/after-pack-sign.cjs`，在生成 dmg 前对 `.app` 做 ad-hoc 签名（`codesign --force --deep --sign - --timestamp=none`），并 `codesign --verify` 自检，失败就让构建失败（避免悄悄发出坏包）。

> `--deep` 对签名而言已被 Apple 标记为不推荐，但对「整体未签名的 Electron bundle 一次性签完嵌套 Framework/Helper」仍是最省事且被广泛使用的做法。将来若接入 Developer ID + 公证，应删掉这个 hook 并配置 `mac.identity`。

**根治（需花钱）**：$99/年 Apple Developer 账号 → `identity`（Developer ID Application）+ `notarize`（`xcrun notarytool`），用户即可双击直开。

### 坑 M5：删除 `dist-electron` 报 `Operation not permitted` / Device busy

与 Windows 类似：上一次构建的进程没退干净，或 `Pi Agent.app` 还在运行。处理：

```bash
pkill -f "Pi Agent" || true
pkill -f Electron || true
sleep 2 && rm -rf dist-electron
```

### 坑 M6：`iconutil` 报错 / 图标没生成

`iconutil` 是 macOS 专属命令，`make-icon.mjs` 只在 `darwin` 下生成 `.icns`（Windows/Linux 会打印跳过）。若报错，确认 `desktop/icon.icns` 可手动重建：

```bash
npm run desktop:icon
# 或纯手工：
mkdir icon.iconset
sips -z 512 512 desktop/icon.ico --out icon.iconset/icon_512x512.png  # 仅示意
iconutil -c icns icon.iconset -o desktop/icon.icns
```

`.icns` 与 `.ico` 都应提交进仓库（与 Windows 版保留 `icon.ico` 同理），普通用户无需重跑图标脚本。

---

## 5. 分发：用户安装时会碰到什么

未做代码签名/公证，所以每个下载了 dmg 的用户**第一次打开**会被 Gatekeeper 拦。请把下面两条写进给用户的说明：

**方式一（图形界面，推荐）**
1. 打开 dmg，把 `Pi Agent` 拖进「应用程序」。
2. 在「应用程序」里找到 Pi Agent，**右键 → 打开**（不是双击），弹窗里再点「打开」。只需第一次。

**方式二（命令行，一次性解除隔离）**

```bash
xattr -rd com.apple.quarantine "/Applications/Pi Agent.app"
```

若仍提示「已损坏」，多半是没做 ad-hoc 签名（见坑 M4）：

```bash
codesign --force --deep --sign - "/Applications/Pi Agent.app"
```

**用户可能遇到的其它情况**

- **首次启动慢 / 白屏**：首次要预热内置服务，10–30 秒正常，超过 ~45 秒会显示重试页，点「重试加载」即可。
- **与已装的 pi CLI 共存**：不冲突。共用 `~/.pi/agent`，seed 有 `existsSync` 守卫绝不覆盖。想隔离就设 `PI_CODING_AGENT_DIR`。
- **需要 git / npm / npx 的功能**（worktree、技能/插件安装）：App 已把 Homebrew、`/usr/local/bin`、`~/.local/bin` 追加进子进程 PATH；若你的 node/npm 装在别处（如 nvm、fnm、asdf），可能需要在 shell 里配置或改用绝对路径安装。

---

## 6. 不会踩的坑（已确认）

| 担心点 | 结论 |
|--------|------|
| 原生模块要在 Mac 上现场编译 | 不需要。pi-tui 自带 `darwin-arm64`/`darwin-x64` prebuilds；`sharp` 有 `@img/sharp-darwin-*` 预编译包；`@next/swc-darwin-*` 由 npm 自动选装。`clipboard-win32-x64` 只在 Windows 装 |
| 防火墙弹「允许访问」 | 不会。只 listen 127.0.0.1（loopback），macOS 应用防火墙默认不过滤 loopback |
| `seed.cjs` 的 `mode: 0o600` | macOS 原生支持 Unix 权限位，正常工作 |
| 关窗口退出应用 | 不会。`window-all-closed` 在 darwin 下不退出（标准行为），点 Dock 图标会重开窗口 |
| Intel Mac 上能否打 arm64 包 | 不能，只能打 x64。要 arm64 请用 Apple Silicon，或 GitHub Actions 的 `macos-14`（arm64）runner |

---

## 7. 相关文档

- [Windows 桌面打包说明（中文）](./desktop-build.zh-CN.md) — 架构细节、踩坑全集（两版共用）
- [Mac 改造规划（中文，已实施）](./desktop-mac-plan.zh-CN.md)
- [发布流程](./release.md)
- [主 README（中文）](../README.zh-CN.md) — 快速开始、桌面版概览
