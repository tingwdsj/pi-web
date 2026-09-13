# Mac 桌面版改造规划（设计文档 · 已实施）

> **状态：已实施（2026-09）。** 实际改造已完成并成功产出 arm64 + x64 两个 dmg；施工细节、实际踩到的新坑（npm 12 的 `allow-remote` / install-scripts、`/Users/**` 追踪排除地雷、arm64 ad-hoc 签名）见 **[`desktop-build-mac.zh-CN.md`](./desktop-build-mac.zh-CN.md)**。本文保留作背景与决策记录。

本文档是 Pi Agent **Mac 版**的改造规划。Windows 版已完成并发布（`Pi Agent Setup 0.8.0.exe`），Mac 版沿用同一套「Electron 外壳 + Next standalone 服务 + 内置 Node 22 运行时」架构，**不需要重新设计，只需把若干 Windows 特化点换成 Mac 版**。

> 配套阅读：Windows 版的完整踩坑记录见 [`desktop-build.zh-CN.md`](./desktop-build.zh-CN.md)。

---

## 0. 先回答两个核心问题

### Q1：必须区分 M 系列和 Intel 吗？

**必须。** 两者是不同的 CPU 架构，二进制不能互通：

| 系列                  | 架构        | Mac 机型                              |
| ------------------- | --------- | ----------------------------------- |
| Apple Silicon（M 系列） | **arm64** | M1 / M2 / M3 / M4 的所有 Mac（2020 年底起） |
| Intel               | **x64**   | 2020 年前的所有 Mac                      |

涉及 4 类二进制都要分架构：**Electron 本体、Node 运行时、Next 的 SWC、sharp（若用到）**。

**你的决定：arm64 + x64 各出一个 dmg**（见下方「发布产物」）。用户根据自己 CPU 下对应的包。M 系列 Mac 虽能用 Rosetta 2 跑 x64 版，但原生 arm64 更快更省电，不推荐混用。

### Q2：代码签名怎么办？

**你的决定：先不签名**，跑起来再说。代价是用户首次打开会被 Gatekeeper 拦（「无法打开，因为来自身份不明的开发者」），需要右键 → 打开，或命令行 `xattr -d com.apple.quarantine` 解除。详见下方「分发坑」。

---

## 1. 好消息：原生模块情况对 Mac 友好（已查清）

这是 Mac 打包最大的潜在雷区，我已扫描确认：

**项目运行时实际会加载的原生模块：**

| 模块                                 | 平台包情况                                                                                      | Mac 风险                                                      |
| ---------------------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| `@next/swc-*`                      | Next 按平台装对应的 SWC 二进制                                                                       | ✅ Mac 上 `npm install` 自动装 `@next/swc-darwin-arm64` / `-x64` |
| `@earendil-works/pi-tui` 的 `.node` | **已自带 darwin-arm64 + darwin-x64 prebuilds**（`native/darwin/prebuilds/darwin-{arm64,x64}/`） | ✅ 无需编译，npm install 时 win32 包不会装，darwin 包会装                  |
| `sharp`（图标用）                       | optionalDependencies 列了全部平台（含 `@img/sharp-darwin-arm64/x64`）                               | ✅ Mac 上自动装对应平台包。**且 sharp 只在构建期生成图标用，不进运行时**                |
| `clipboard-win32-x64`              | 仅 win32，仅 pi-tui 的 win32 分支用                                                               | ✅ Mac 不装，无影响                                                |

**结论：pi-coding-agent 没有需要在 Mac 上现场编译的原生模块**（pi-tui 用 prebuilds，sharp 是构建期工具）。这是改造能成立的前提，已验证。

> 唯一要留意：`@vercel/nft` 文件追踪器是按**构建机器的平台**追踪原生模块的——在 Mac 上构建，自然只追踪 darwin 的 `.node`，不会把 win32 的打进去（反之亦然）。这正是我们想要的。

---

## 2. 改造范围：只动 5 处平台特化点

架构层（Electron 拉起 Next standalone 服务）完全平台无关，**不用改**。需要改的只有以下 5 个文件里的平台特化逻辑：

| 文件                               | 改什么                                                                                                         | 工作量                 |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------- |
| `desktop/fetch-node.cjs`         | 从「硬编码 win-x64 + .zip + node.exe」改成「按 `process.platform`/`process.arch` 选 URL，Mac 用 `.tar.gz` + 无扩展名 `node`」 | ⚠️ **重写**（最大改动）     |
| `desktop/electron-builder.yml`   | 新增 `mac:` 段（dmg + arm64/x64 + .icns 图标）                                                                     | ⚠️ 中                |
| `desktop/main.cjs`               | nodePath 从 `node/node.exe` 改为按平台取 `node/node`（Mac）；错误页文案区分平台                                                | ⚠️ 小                |
| `desktop/lib/spawn.cjs`          | `buildServerEnv` 环境变量白名单补 Mac 变量；nodePath 注释更新                                                              | ⚠️ 小（killTree 已跨平台） |
| `desktop/icon.ico` → `icon.icns` | 生成 Mac 多分辨率图标                                                                                               | ⚠️ 小                |

**不用动的文件**（已确认平台无关）：`lib/port.cjs`、`lib/seed.cjs`、`preload.cjs`、`ensure-standalone-chunks.cjs`。

> ⚠️ **勘误**：本节原来把 `next.config.ts` 列为「不用动」，并称其 `outputFileTracingExcludes` 已含 Mac 路径。实测这是个地雷：其中的 `/Users/**` 会被 Next 用 `contains` 匹配**绝对路径**，而项目就在 `/Users/<你>/...` 下，导致整个项目的依赖被排除出 standalone。实际实施时已改为**按平台构造**排除列表（POSIX 不设绝对路径排除）。详见 [`desktop-build-mac.zh-CN.md` 坑 M3](./desktop-build-mac.zh-CN.md)。

---

## 3. 逐项改造细节

### 3.1 `desktop/fetch-node.cjs`（重写）

**现状**（Windows 专用）：

```js
const NODE_VERSION = "22.14.0";
const DOWNLOAD_URL = `${MIRROR}/v${NODE_VERSION}/node-v${NODE_VERSION}-win-x64.zip`;
// ...手写 ZIP 中央目录解析，提取 node.exe
const NODE_EXE = path.join(RUNTIME_DIR, "node.exe");
```

**改成**：按 `process.platform` + `process.arch` 动态选 URL 和文件名。

| 平台                 | URL 段                               | 归档格式   | 可执行文件名     | 解压方式       |
| ------------------ | ----------------------------------- | ------ | ---------- | ---------- |
| `win32` + `x64`    | `node-v22.14.0-win-x64.zip`         | zip    | `node.exe` | 现有 ZIP 解析器 |
| `darwin` + `arm64` | `node-v22.14.0-darwin-arm64.tar.gz` | tar.gz | `bin/node` | tar 解压     |
| `darwin` + `x64`   | `node-v22.14.0-darwin-x64.tar.gz`   | tar.gz | `bin/node` | tar 解压     |

**关键差异**：

- Mac 的 Node 包是 `.tar.gz`，内部结构是 `node-v22.14.0-darwin-arm64/bin/node`（不是扁平的 `node.exe`）。需要从 tar.gz 里提取 `bin/node` 这一项。
- **解压方式建议直接调系统 `tar` 命令**（Mac、Linux、Win10 1803+ 都自带 `tar.exe`），比手写 tar 解析器更稳。代码大概是：`child_process.execSync('tar -xzf archive.tar.gz -C <tmpdir> bin/node', ...)` 然后把提取出的 `bin/node` 移到目标位置。
- Mac 的可执行文件要 `chmod 0o755`（tar 解压通常已带权限，但跨平台保险起见显式设一次）。

**输出文件名也要平台化**：`node-runtime/node`（Mac）vs `node-runtime/node.exe`（Windows）。`.gitignore` 现在只忽略了 `node.exe`，要补一条 `node-runtime/node`。

**幂等性保留**：已存在则跳过（Windows 版已有此逻辑，照搬）。

**为什么不能像 Windows 那样手写解析器**：tar.gz 比 zip 多一层 gzip + tar 结构（两段头部），手写解析易错；系统 `tar` 命令跨平台可用且可靠，优先用它。

### 3.2 `desktop/electron-builder.yml`（加 mac 段）

**现状**：只有 `win:` 段（NSIS x64，icon.ico），`extraResources` 把 `node.exe` 打到 `node/node.exe`。

**改动**：

**(a) 新增 `mac:` 段**（与 `win:` 平级）：

```yaml
mac:
  target:
    - target: dmg
      arch:
        - arm64
        - x64
  icon: desktop/icon.icns
  category: public.app-category.developer-tools
  # 不签名（你的决定）：不写 identity 字段
  hardenedRuntime: false   # 未签名时不强制 hardenedRuntime
```

这会让 `electron-builder` 在 Mac 上跑时产出两个 dmg：`Pi Agent-0.8.0-arm64.dmg` 和 `Pi Agent-0.8.0-x64.dmg`。

**(b) `extraResources` 的 node 路径要平台化**：

现状（硬编码 Windows）：

```yaml
- from: desktop/node-runtime/node.exe
  to: node/node.exe
```

改成用通配 / 两条：

```yaml
- from: desktop/node-runtime/
  to: node/
  filter:
    - "node*"
```

这样 Mac 构建时会把 `node-runtime/node`（无扩展名）打到 `resources/node/node`，Windows 构建时把 `node.exe` 打到 `resources/node/node.exe`。`fetch-node.cjs` 保证了 `node-runtime/` 里只有当前平台的那个二进制。

### 3.3 `desktop/main.cjs`（nodePath 平台化 + 文案）

**现状**（line 122）：

```js
const nodePath = path.join(process.resourcesPath, "node", "node.exe");
```

**改成**（按平台取可执行名）：

```js
const nodeBinary = process.platform === "win32" ? "node.exe" : "node";
const nodePath = path.join(process.resourcesPath, "node", nodeBinary);
```

**错误页文案**（line 77 的 `resources\node\node.exe` 提示）：Mac 上杀软隔离那段不适用，按 `process.platform` 显示不同提示。Mac 的常见失败是「权限被 Gatekeeper 拦」或「node 没有可执行权限」，文案要相应调整。

> 注：`main.cjs` 现有的 `window-all-closed`（line 238）已是 `if (process.platform !== "darwin") app.quit();`——Mac 上关窗口不退出应用（标准行为），**不用改**。

### 3.4 `desktop/lib/spawn.cjs`（环境变量白名单 + nodePath 注释）

**现状**：`buildServerEnv` 有 Windows 偏向的环境变量白名单；`killTree` 已是跨平台的（win32 → `taskkill /T /F`，否则 → SIGTERM）。

**改动**：

- `buildServerEnv` 白名单补 Mac 需要的变量：`HOME`、`SHELL`、`TMPDIR`、`LANG`、`LC_ALL`、`PATH`（PATH 已有）。Mac 的 `~/.pi` 路径解析依赖 `HOME`。
- 顶部注释里的 `node.exe` 引用改成「平台可执行名」。
- `killTree` **不用动**。

> spawn 的 `env` 传递：Mac 上 `cross-spawn` 不需要 `.cmd` 解析那套（那是 Windows 专属问题），Mac 有真实的 `npx`/`npm` 符号链接，`lib/npx.ts` 已用的 cross-spawn 在 Mac 上同样工作良好，**不用改**。

### 3.5 图标 `desktop/icon.icns`

**现状**：只有 `icon.ico`（Windows 多分辨率）。Mac 用 `.icns` 格式。

**生成方式**（在 Mac 上，或用现有 `make-icon.mjs` 改造）：从源 SVG 渲染多尺寸 PNG（16/32/64/128/256/512/1024），再用 `iconutil` 或 `png2icns` 打包成 `.icns`。Mac 自带 `iconutil`：

```bash
mkdir icon.iconset
# 生成各尺寸 PNG 放进 icon.iconset/
iconutil -c icns icon.iconset -o desktop/icon.icns
```

也可以在 `make-icon.mjs` 里加 Mac 分支（sharp 能输出 PNG，再调 `iconutil`）。这一步必须在 Mac 上跑（`iconutil` 是 Mac 专属工具）。

---

## 4. 构建流程（必须在 Mac 上跑）

electron-builder **不能交叉打 Mac 包**（不像 Windows 能在 Linux 上打）。所以 Mac 构建必须满足：

| 产物            | 构建主机要求                                                               |
| ------------- | -------------------------------------------------------------------- |
| `*-arm64.dmg` | 必须在 **M 系列 Mac** 上构建                     |
| `*-x64.dmg`   | 在 M 系列 Mac 或 Intel Mac 上都行（electron-builder 能在 arm64 Mac 上交叉出 x64 包） |

**你有 M 系列 Mac 的话**，一台机器就能同时产出 arm64 和 x64 两个 dmg（electron-builder 会用 Rosetta 或交叉工具链）。只有 Intel Mac 的话，只能产 x64，arm64 那个产不了。

**构建步骤**（在 Mac 上）：

```bash
git clone git@github.com:tingwdsj/pi-web.git
cd pi-web
npm install                          # npmmirror 已配，electron 二进制走镜像
npm run desktop:icon                 # 先生成 icon.icns（若 make-icon.mjs 已加 Mac 分支）
npm run desktop:build                # 自动: fetch-node(darwin) → next build → nft → electron-builder
```

产物在 `dist-electron/`：`Pi Agent-0.8.0-arm64.dmg`、`Pi Agent-0.8.0-x64.dmg`，每个约 180–200 MB。

> `fetch-node.cjs` 重写后，在 Mac 上跑会自动下载 `node-v22.14.0-darwin-arm64.tar.gz`（或 x64），解出 `node` 放到 `node-runtime/node`。`desktop:build` 脚本本身不用改，它调的还是 `node desktop/fetch-node.cjs`。

---

## 5. 分发坑（Mac 特有，用户会碰到）

### 坑 A：Gatekeeper 拦截未签名应用（最大障碍）

**现象**：用户双击 dmg 装好后，打开 app 弹「无法打开“Pi Agent”，因为来自身份不明的开发者」。

**你的决定：不签名**。用户的绕过方式（二选一）：

- **图形界面**：在 Finder 里找到 Pi Agent，**右键 → 打开**（不是双击），弹窗里点「打开」。只需第一次。
- **命令行**（一次性解除整个 dmg 的隔离属性）：
  
  ```bash
  sudo xattr -rd com.apple.quarantine /Applications/Pi\ Agent.app
  ```

**给用户的说明文档要写清楚这两条**，这是 Mac 分发的标配。你之前 Windows 版写的「使用说明」文档（`dist-electron/使用说明.docx`）也要为 Mac 版补这一段。

> 若将来想根治：花 $99/年买 Apple Developer 账号，配置 `identity`（Developer ID Application）+ `notarize`（`xcrun notarytool`），用户就能双击直开。这是 Mac 分发的「正道」，但需要真金白银和证书管理。

### 坑 B：`node` 子进程被 macOS 安全机制拦

类似 Windows 的杀软问题，但 Mac 上少见。Pi Agent 会 spawn 一个 `node` 子进程（从 `Resources/node/node`）。若 app 未签名且未公证，macOS 对子进程执行的限制更严。理论上不签名也能跑（Gatekeeper 拦的是 app 启动，不是子进程），但若用户开了 SIP 的严格模式可能有问题。**先观察**。

### 坑 C：首次启动慢 / 超时白屏

和 Windows 一样，首次要预热 Next standalone 服务，10–30 秒正常。`main.cjs` 已有超时重试页（`loadErrorPage`），Mac 同样生效，**不用改**。

### 坑 D：路径差异

Mac 上 `~/.pi/agent` 路径是 `/Users/<用户名>/.pi/agent`，技能/插件装到这里。`seed.cjs` 用 `os.homedir()`（平台无关），**不用改**。skills/plugins 的 `npm --prefix` 安装在 Mac 上同样工作（Mac 有真实 `npm` 符号链接，无 `.cmd` 问题）。

---

## 6. 待你确认 / 决策的事项

| 事项               | 现状             | 需要你定                                                                                    |
| ---------------- | -------------- | --------------------------------------------------------------------------------------- |
| 架构范围             | arm64 + x64 都出 | ✅ 已定                                                                                    |
| 代码签名             | 不签名            | ✅ 已定                                                                                    |
| 动手时机             | 只要规划，先不动手      | ✅ 已定                                                                                    |
| **是否有 M 系列 Mac** | 未知             | ⚠️ 关键：决定能否产出 arm64 包。若只有 Intel Mac 或没有 Mac，需要用 GitHub Actions 的 `macos-14`（arm64）runner |
| icon.icns 生成方式   | 待定             | Mac 上 `iconutil` 生成，或借现成工具                                                              |
| Mac 使用说明文档       | 未写             | 仿照 Windows 版的 `使用说明.md/.docx`，加 Gatekeeper 解除说明                                         |

---

## 7. 推荐的实施顺序（等你拍板后）

1. **阶段 1（在现有 Windows 机器上就能做）**：重写 `fetch-node.cjs`、改 `electron-builder.yml` 加 mac 段、改 `main.cjs`/`spawn.cjs` 的平台分支、补 `.gitignore`。这些**纯代码改动，不需要 Mac**，改完语法可验证，提交到 git。
2. **阶段 2（在 Mac 上）**：clone → `npm install` → 生成 `icon.icns` → `npm run desktop:build` → 得到两个 dmg。
3. **阶段 3（分发）**：在 M 系列 Mac 上测试 arm64 版，Intel Mac（或 Rosetta）测试 x64 版 → 两个 dmg 传到同一个 GitHub Release → 写 Mac 使用说明文档。

阶段 1 可以现在就开始（如果你点头），阶段 2、3 必须有 Mac。

---

## 8. 相关文档

- [Windows 桌面打包说明（中文）](./desktop-build.zh-CN.md) — 架构细节、踩坑全集（Mac 版会复用同一架构）
- [Windows 桌面打包说明（英文）](./desktop-build.md)
- [发布流程](./release.md)
