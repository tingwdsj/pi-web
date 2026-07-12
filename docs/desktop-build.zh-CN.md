# 桌面端打包说明（Windows）

本文档面向**想自己从源码打包 Pi Agent Windows 桌面版**的人，记录打包流程、各文件职责，以及打包/分发过程中真实踩过的坑。日常使用请看[主 README](../README.zh-CN.md)的「桌面版（Windows）」一节。

> 本文档对应的代码在 `desktop/` 目录下，构建配置在 `desktop/electron-builder.yml`。

---

## 1. 架构一览

Pi Agent 桌面版 = **Electron 外壳 + 内置 Next.js standalone 服务 + 内置 Node 22 运行时**。

```
Pi Agent.exe（Electron 主进程，main.cjs）
  ├─ 首次启动：seed ~/.pi/agent/{models.json, settings.json}（已存在则跳过）
  ├─ 挑一个空闲 loopback 端口
  ├─ spawn resources/node/node.exe 跑 resources/server/server.js（Next standalone）
  ├─ 轮询 /api/home 直到 200
  └─ BrowserWindow 加载 http://127.0.0.1:<port>/
```

关键决策：**不用 Electron 自带的 Node 跑 Next 服务**，而是单独 ship 一个 Node 22。原因见下文「坑 4」。

安装后布局（`%LOCALAPPDATA%\Programs\Pi Agent`）：

```
Pi Agent.exe
resources/
  app/                 ← Electron 应用包（asar 关闭）
    main.cjs           ← 主进程入口
    preload.cjs
    lib/               ← port.cjs / seed.cjs / spawn.cjs
    seed-models.json   ← 首次 seed 用的 DeepSeek 模板
    seed-settings.json
    icon.ico
    package.json       ← main: main.cjs
  server/              ← Next.js standalone（自带 node_modules）
    server.js
    .next/static/
    node_modules/@earendil-works/...   ← pi SDK + LLM SDK
  node/
    node.exe           ← Node 22 运行时（约 80 MB）
```

---

## 2. 打包步骤

### 前置

- Windows 10/11，Node 18+（用于跑 `next build` 和 `electron-builder`，与运行时无关）
- 已 `npm install`（装好 `electron`、`electron-builder`、`cross-env` 等 devDeps）

### 一键打包

```bash
npm run desktop:build
```

它等价于：

```bash
# 1. （首次）下载 Node 22 运行时到 desktop/node-runtime/node.exe（已存在则跳过）
node desktop/fetch-node.cjs

# 2. Next 生产构建（standalone 输出 + 文件追踪）
cross-env NODE_OPTIONS="--require ./desktop/win-eperm-patch.cjs" next build --webpack

# 3. 补齐 nft 漏追踪的运行时资源（pi CLI / 导出模板 / 主题）
node desktop/ensure-standalone-chunks.cjs

# 4. electron-builder 打 NSIS 安装包
electron-builder --config desktop/electron-builder.yml
```

产物：`dist-electron/Pi Agent Setup <version>.exe`（约 175 MB）。

### 单独生成图标（可选）

```bash
npm run desktop:icon     # 用 sharp 把 SVG 渲染成多尺寸 icon.ico
```

图标已提交进仓库（`desktop/icon.ico`），通常不需要重跑，除非改了 `desktop/make-icon.mjs` 里的设计。

### 开发模式（热重载）

```bash
npm run desktop:dev      # cross-env PI_DESKTOP_DEV=1 electron desktop/main.cjs
```

dev 模式下 `main.cjs` 会 spawn `next dev`（固定端口 30141）而不是 standalone server，并跳过 Node 22 运行时（用 dev 环境的 Node）。

---

## 3. 各文件职责

| 文件 | 作用 |
|------|------|
| `desktop/main.cjs` | Electron 主进程：单例锁、seed、挑端口、spawn server、开窗、退出树杀、错误页 |
| `desktop/lib/port.cjs` | `pickFreePort()`：listen 端口 0 让 OS 分配，再 close 返回 |
| `desktop/lib/seed.cjs` | `seedIfMissing()`：镜像 SDK 的 `getAgentDir()`，existsSync 守卫，绝不覆盖 |
| `desktop/lib/spawn.cjs` | `startNextServer()` / `waitForReady()` / `killTree()`；env 白名单在这里 |
| `desktop/preload.cjs` | v1 占位，空实现 |
| `desktop/seed-models.json` | DeepSeek-only 的 models.json 模板（apiKey 用 `$DEEPSEEK_API_KEY` 占位） |
| `desktop/seed-settings.json` | 默认 provider/model/主题 |
| `desktop/skip-deps.js` | electron-builder `beforeBuild` hook，返回 false 跳过把项目 node_modules 拷进 app 包 |
| `desktop/win-eperm-patch.cjs` | 打包期 monkey-patch fs，吞掉项目目录外的 EPERM（见「坑 1」） |
| `desktop/make-icon.mjs` | 构建期脚本：SVG → 多尺寸 ICO |
| `desktop/node-runtime/node.exe` | 内置 Node 22.14.0 win-x64 二进制（**不入 git**，由 `fetch-node.cjs` 下载，见「坑 4」） |
| `desktop/fetch-node.cjs` | 首次构建前从 npmmirror 下载 node.exe（幂等） |
| `desktop/electron-builder.yml` | 打包配置（NSIS、perUser、asar:false、文件映射、extraResources） |

---

## 4. 打包时可能遇到的坑

### 坑 1：`EPERM scandir 'C:\Users\<user>\Application Data'`（或类似受保护目录）

**现象**：`next build` 阶段，Next 的 `@vercel/nft` 文件追踪器扫描依赖时，碰到 Vista 时代的受保护 junction（`Application Data`、`My Documents` 等），抛 `EPERM`，构建中断。

**原因**：nft tracer 会跟随 symlink/junction，而这些目录普通用户无权访问。

**对策**（已实装）：`desktop/win-eperm-patch.cjs` 在构建期 monkey-patch `fs.readdir` / `readdirSync` / `readlink` / `lstat` / `stat`，对**项目目录之外**的路径吞掉 EPERM/EACCES。通过 `NODE_OPTIONS="--require ./desktop/win-eperm-patch.cjs"` 注入（见 `package.json` 的 `desktop:build:next` 脚本）。

**注意 `isOutsideProject` 的跨盘符陷阱**：项目在 D 盘、home 在 C 盘时，`path.relative(PROJECT_ROOT, target)` 返回的是**绝对路径**（不是 `..` 开头），所以判断「是否在项目外」必须写成：

```js
const rel = path.relative(PROJECT_ROOT, resolved);
const isOutside = rel.startsWith("..") || path.isAbsolute(rel) || rel === resolved;
```

只写 `rel.startsWith("..")` 会在跨盘符时误判为「在项目内」，patch 失效。

还有：`readlink` 读到坏链接时，**不要返回路径本身**（会让 nft 报「Recursive symlink detected」），要 `throw ENOENT`（会被外层吞掉）。

### 坑 2：electron-builder `files` 的单文件 `{from, to}` 对象不生效

**现象**：`electron-builder.yml` 里写 `{from: "desktop/main.cjs", to: "main.cjs"}`，期望把单文件重命名到 app 包根，结果文件没被拷进去，报 `Application entry file "main.cjs" does not exist`。

**原因**：在 app-builder-lib 25.1.8 中，`files` 数组里的**单文件 FileSet 不可靠**（目录 FileSet 正常）。实测目录 FileSet `from: "desktop", to: "."` 能把 `desktop/main.cjs` 平铺到 `resources/app/main.cjs`、`desktop/lib/` 到 `resources/app/lib/`（`getDestinationPath` 用 `path.relative(src, file)` 剥掉 `desktop/` 前缀）。

**对策**（已实装）：用**一个目录 FileSet** 把整个 `desktop/` 平铺到 app 根，配合 `filter` 排除构建期脚本：

```yaml
files:
  - from: desktop
    to: .
    filter:
      - "**/*"
      - "!make-icon.mjs"
      - "!win-eperm-patch.cjs"
      - "!electron-builder.yml"
  - from: .
    to: .
    filter:
      - "package.json"
```

**别用纯字符串排除项**（如往 `files` 里加 `"!node_modules/**"`）：在只有 FileSet 的配置里，任何纯字符串都会触发一个 `from=appDir` 的默认 matcher，它会被补上 `**/*`，把**整个项目**（`.next`、`app/`、`components/`…）都拷进 app 包。

### 坑 3：app 包里塞了 740 MB 重复的 node_modules

**现象**：打包后 `resources/app/node_modules` 有 ~740 MB，是整个项目 production deps 的拷贝（next、pi SDK、aws-sdk、react…）。但 main.cjs 只用 `electron` + Node 内置 + `./lib/*.cjs`，Next 服务跑的是 `resources/server` 里的 standalone node_modules。纯死重。

**原因**：electron-builder 默认会根据 `package.json` 的 `dependencies` 把 production deps 拷进 app 包，这是独立于 `files` 配置的代码路径。`extraMetadata: { dependencies: {} }` **不管用**——`deepAssign` 是合并不是替换，而且拷贝读的是磁盘上的原始 `package.json`，不是合并后的。

**对策**（已实装）：`desktop/skip-deps.js` 作为 `beforeBuild` hook 返回 `false`，设置 `areNodeModulesHandledExternally=true`，完全跳过 node_modules 拷贝。这是官方为此场景提供的机制。安全：sanity check 只验证 `main.cjs` + `package.json` 存在，不检查 node_modules。

效果：app 包从 740 MB → 51 KB。

### 坑 4：`webidl.util.markAsUncloneable is not a function`（API 500）

**现象**：用 `ELECTRON_RUN_AS_NODE=1` 让 Electron 内置 Node 跑 standalone server，首页能加载，但 `/api/models-config`、`/api/default-cwd` 等碰 pi SDK 的 API 全 500，日志报 `webidl.util.markAsUncloneable is not a function`。

**原因**：Electron 33 内置 Node 20.18，其 `worker_threads`/undici 没有 `markAsUncloneable`（Node 22+ 才有）。Next 16.2.9 的 `@edge-runtime/primitives` 会调用它。用 `ELECTRON_RUN_AS_NODE` 跑 server 时，用的是 Electron 内置的 Node，于是炸。

**对策**（已实装）：单独 ship 一个 Node 22 的 `node.exe`（`desktop/node-runtime/node.exe`，从 npmmirror 下载 `node-v22.14.0-win-x64.zip` 取出），打包进 `resources/node/`。`spawn.cjs` 优先用它跑 server，而不是 electron.exe。

> `node.exe` 是 80MB 二进制，**不入 git**（见 `.gitignore`）。`desktop/fetch-node.cjs` 会在 `npm run desktop:build` 时自动从 npmmirror 下载并解压；已存在则跳过（幂等）。也可单独跑 `npm run desktop:fetch-node`。

**更新 node.exe 版本的方法**：删掉 `desktop/node-runtime/node.exe`，改 `desktop/fetch-node.cjs` 里的 `NODE_VERSION`，再跑 `npm run desktop:fetch-node`。验证：

```bash
./desktop/node-runtime/node.exe --version    # 应输出对应版本号
./desktop/node-runtime/node.exe -e "console.log(typeof require('worker_threads').markAsUncloneable)"  # 应输出 function
```

换 Node 大版本时，确认 `worker_threads.markAsUncloneable` 仍是 function（Next 16 edge-runtime 依赖它）。

### 坑 5：`Cannot find module './lib/port'`

**现象**：打包版启动即崩，弹窗 `A JavaScript error occurred in the main process: Error: Cannot find module './lib/port'`。

**原因**：Node 的 `require()` **不自动解析 `.cjs` 扩展名**（只认 `.js`/`.json`/`.node`）。`main.cjs` 里 `require("./lib/port")` 找不到 `lib/port.cjs`。

**对策**（已实装）：所有 `require` 本地 `.cjs` 模块都显式带后缀：`require("./lib/port.cjs")`。`desktop/main.cjs` 顶部有注释说明。

### 坑 6：`rm: cannot remove 'dist-electron/...': Device or resource busy`

**现象**：重新打包时 `rm -rf dist-electron` 失败，提示设备忙。

**原因**：上一次 build 的进程没退干净，或 Pi Agent.exe 还在运行，或 Windows Defender 正在扫描刚生成的 exe 导致句柄延迟释放。

**对策**：

```bash
# 杀残留进程
taskkill //F //IM "Pi Agent.exe"
taskkill //F //IM "electron.exe"

# 等几秒再删（Defender 句柄释放有延迟）
sleep 5 && rm -rf dist-electron
```

### 坑 7：electron / winCodeSign 二进制下载卡住（国内网络）

**现象**：`npm install` 时 electron 二进制从 GitHub 下载卡死，或 electron-builder 下载 winCodeSign 超时。

**对策**（已实装）：仓库根 `.npmrc` 配了 npmmirror 镜像：

```ini
electron_mirror=https://registry.npmmirror.com/-/binary/electron/
electron_builder_binaries_mirror=https://registry.npmmirror.com/-/binary/electron-builder-binaries/
```

打包时也带环境变量兜底：

```bash
export ELECTRON_BUILDER_BINARIES_MIRROR="https://registry.npmmirror.com/-/binary/electron-builder-binaries/"
```

### 坑 8：winCodeSign 创建 symlink 失败

**现象**：打包报 winCodeSign 相关的 symlink 错误。

**原因**：7za 在 Windows 上创建符号链接需要管理员权限或开发者模式。

**对策**：开启 Windows 开发者模式（设置 → 隐私和安全性 → 开发者选项），或用管理员身份跑打包。命令行开启：

```powershell
reg add "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\AppModelUnlock" /v AllowDevelopmentWithoutDevLicense /t REG_DWORD /d 1 /f
```

---

## 5. 分发时用户可能遇到的坑

这些不是打包者的问题，是**装到别人机器上**可能出现的，提前知道有助于写说明和答疑。详见[主 README 的「启动失败的排查」](../README.zh-CN.md#启动失败的排查)。

### 用户坑 A：杀毒软件隔离 `node.exe`（最高风险）

Pi Agent 从用户目录（`%LOCALAPPDATA%\Programs`）spawn 一个 `node.exe` 子进程，**精确命中**多家安全产品的「可疑 Node 子进程」检测规则（Elastic、Gurucul、SigmaHQ 都有针对此模式的规则）。Windows Defender 的 `Trojan:Win32/SuspExec.SE`、360、火绒都可能误杀。

**用户表现**：打开后白屏或错误页。

**给用户的指引**：去杀软隔离区恢复 `node.exe`，把安装目录加入白名单/信任区。

**根治方向**（未实装）：用 Electron 的 `utilityProcess.fork()` 在 Electron 自带 Node 里跑 server，不再 ship 独立 node.exe。但要重新解 Node 22 vs Electron Node 20 的 edge-runtime 兼容（见坑 4），可能靠 polyfill `markAsUncloneable` 回退到 `ELECTRON_RUN_AS_NODE`。改动较大，建议先观察真实误杀率再决定。

### 用户坑 B：SmartScreen 拦截

未签名安装包首次运行弹「Windows 已保护你的电脑」。点「更多信息 → 仍要运行」即可，每版本一次。未签名文件**每个新版本都从零声誉开始**（微软官方说法），所以改版本号就要重新积累声誉。大规模分发建议做代码签名（EV 证书可立即获得声誉）。

### 用户坑 C：首次启动慢 / 超时白屏

首次启动要预热内置服务，10–30 秒正常，杀软实时扫描时更久。超过 ~45 秒会显示重试页（`main.cjs` 的 `loadErrorPage`），点「重试加载」即可。这个错误页是 `main.cjs` 在 `startNextServer` / `waitForReady` / `loadURL` 三处都加了 try/catch 后才有的——没有它的话会抛未捕获的 `ERR_CONNECTION_REFUSED` rejection 直接白屏。

### 用户坑 D：与已装的 pi CLI 共存

不冲突。桌面版与 pi CLI 共用 `~/.pi/agent`，seed 有 `existsSync` 守卫绝不覆盖，两者甚至能同时运行（各用不同端口）。想隔离就设 `PI_CODING_AGENT_DIR` 环境变量。详见[主 README](../README.zh-CN.md#桌面版windows)。

---

## 6. 不会踩的坑（已确认）

| 担心点 | 结论 |
|--------|------|
| Windows 防火墙弹「允许访问」 | 不会。只 listen 127.0.0.1（loopback），Windows 防火墙默认不过滤 loopback |
| Electron 加载 http://127.0.0.1 被限制 | 不会。BrowserWindow loadURL HTTP localhost 是标准模式 |
| 同端口 fetch 的 CORS | 不会。页面和 API 同端口 = 同源 |
| Win10 1909 跑不了 | 能跑。Electron 33 官方只要求「Windows 10 or later」，无 build 号限制 |
| `seed.cjs` 的 `mode: 0o600` | Windows 不认 Unix 权限位，静默忽略，不报错 |

---

## 7. 相关文档

- [主 README（中文）](../README.zh-CN.md) — 快速开始、桌面版概览、启动失败排查
- [主 README（英文）](../README.md)
- [发布流程](./release.md) — npm + GitHub Release 的发布清单
