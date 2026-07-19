# pi-web

[English](./README.md)

[pi 编程智能体](https://github.com/badlogic/pi-mono) 的本地网页界面。它会读取本机的 pi 会话文件，在浏览器里提供会话管理、实时对话、模型配置、技能管理和项目文件预览。
本项目是在@agegr原作者版本基础上进行UI/UX改造，并完成桌面端改造。原项目地址：[pi-web原作者版本](https://github.com/agegr/pi-web)

## 桌面版（Windows）

本 fork 还可以打包成独立的 Windows 桌面软件——无需安装 Node.js 或 pi CLI。pi 编码引擎和各家 LLM SDK 全部内置于 `.exe` 中。

**自行构建：**

```bash
npm install
npm run desktop:build
```

会先跑 `next build`（standalone 输出），再跑 `electron-builder`，产出 `dist-electron/Pi Agent Setup <version>.exe`——一个 NSIS 安装包，按用户安装（无需管理员）到 `%LOCALAPPDATA%\Programs\Pi Agent`。

**首次运行：** 程序会在 `~/.pi/agent/` 下种入 `models.json`（仅 DeepSeek，Key 用 `$DEEPSEEK_API_KEY` 占位符）和 `settings.json`（若它们尚不存在）。你唯一要做的是打开 Models 面板填入 DeepSeek API Key，然后开始对话。

**与 pi CLI 共存：** 桌面版与 pi CLI 共用同一个数据目录（`~/.pi/agent`）。如果你已经在用 pi，桌面版会直接继承你已有的配置、API Key 和会话历史——绝不覆盖。两者甚至可以同时运行（各用不同端口）。若想隔离，启动前设置 `PI_CODING_AGENT_DIR` 指向独立目录即可。

**注意事项：**
- 目标系统：Windows 10 x64（建议 1909+）。未做代码签名，首次安装时 SmartScreen 会拦截，点「更多信息 → 仍要运行」即可。
- 本版不含自动更新；升级时重新 `npm run desktop:build` 并重装。
- 开发模式（热重载）：`npm run desktop:dev`——同时启动 `next dev` 和 Electron 窗口。

**启动失败的排查：**

- **杀毒软件删了文件 / 打开是白屏。** Pi Agent 内置了 Node 22 运行时（`resources/node/node.exe`），启动时会把它作为子进程拉起来跑界面服务。部分杀毒软件（Windows Defender、360、火绒等）会把「从用户目录 AppData 里跑起来的 node.exe」判定为可疑行为并隔离。如果打开后是白屏或错误页，去杀毒软件的隔离区看看，把 `node.exe`（最好整个安装目录）恢复并加入白名单/信任区。这是未签名应用的现实代价。
- **「Windows 已保护你的电脑」（SmartScreen）。** 首次运行会弹，因为安装包没有代码签名。点「更多信息 → 仍要运行」即可，每个版本只需点一次，之后不再拦。
- **首次启动慢。** 首次启动要等内置服务预热，通常 10–30 秒（杀毒软件实时扫描时会更久）。如果超过约 45 秒，应用会显示一个重试页——点「重试加载」即可。
- **端口是动态的。** 应用启动时在 `127.0.0.1` 上挑一个空闲端口，所以永远不会和别的服务冲突，也不会弹防火墙「允许访问」的对话框。

**从源码打包 / 踩坑记录：** 见 [docs/desktop-build.zh-CN.md](./docs/desktop-build.zh-CN.md)，包含完整打包流程、`desktop/` 下各文件职责，以及打包和分发过程中真实踩过的坑（EPERM 文件追踪、electron-builder `files` 的怪行为、内置 Node 22 运行时、杀毒软件误杀等）。

## 功能介绍

- **把历史工作接回来**：打开网页就能按项目找到以前的 pi 对话，不必在终端里翻文件或记住会话路径。
- **放心试不同方向**：可以从某条历史消息重新开始，也可以复制出一条独立的新路线，探索方案时不怕弄乱原来的对话。
- **跨分支工作**：在侧边栏切换 Git worktree，让新会话和 Explorer 跟随你选择的 checkout。
- **边聊边看项目文件**：左侧浏览项目文件，右侧打开源码、文档、图片、音频和 PDF；文件变化会自动刷新，适合边让 agent 改边检查结果。
- **随时掌握会话状态**：在顶部就能看到上下文占用、花费、压缩结果和系统提示，长会话不再像黑箱。
- **少离开当前界面**：模型、登录/API key、模型测试和技能开关都能在网页里处理，配置 agent 时不用在多个工具之间来回切换。

## 本 fork 的定制改动

这个 fork 保留了上游全部功能，并在此基础上做了以下改动：

- **通用文件上传**：上传按钮（➕）现在支持任意格式文件，不再只限图片。文件会写入会话工作目录下的 `uploads/`，命名为 `<时间戳>-<sha256[16]>-<原文件名>`，并以 `@uploads/<文件名>` 引用的形式插入输入框。agent 通过原本的 `@path` 机制读取它们，因此旧的内联 base64 / `images` 链路已彻底移除——图片也走同一条路径。
- **新增 `/api/uploads` 路由**：multipart 接口，把文件落到 `${cwd}/uploads/`（单文件上限 25 MB），返回 cwd 相对路径供 `@` 插入。
- **分支按钮位置调整**：分支按钮从顶栏移到输入框底部控件区（会话信息和系统之间）；点击后仍像会话信息、系统那样用顶部抽屉展开。
- **喇叭按钮**移到控件区最右侧。
- **品牌名称简化**：logo / 标题统一为 `Pi Agent`（去掉了 `Web` 后缀和欢迎界面上的 `web/pi` 版本号）。
- **欢迎界面**：输入框上方会随机显示一句鼓励语。
- **输入框提示**：placeholder 标注了 `Enter` 发送、`Shift+Enter` 换行；发送按钮只保留 icon（去掉了「发送」文字）。
- **弹窗层级修复**：斜杠命令和 `@文件` 菜单改用 `position: fixed`，修复了欢迎界面下被顶部菜单栏遮挡的问题。
- **worktree 切换器隐藏**：侧边栏的 Git worktree 切换器及「仅限 Git 仓库根目录」提示通过 `WORKTREE_UI_HIDDEN` 开关（`components/SessionSidebar.tsx`）在前端隐藏，底层逻辑保留——把开关改回 `false` 即可恢复显示。

### 0.8.0 新增

- **Excel 预览**：`.xlsx` / `.xlsm` 文件用 SheetJS（`xlsx`）转成表格 HTML 渲染，每个 sheet 一张表。
- **旧版二进制文档提示**：旧版 `.doc` / `.xls` / `.ppt` / `.rtf` 等二进制格式不再当文本乱码显示，而是给出友好提示并引导「本地打开」（仅桌面端）。判断逻辑见 `lib/file-types.ts` 的 `isLegacyBinaryDocument`。
- **本地打开**：文件预览的下载按钮旁新增「本地打开」按钮，用系统默认程序打开当前文件（桌面端专属，浏览器隐藏）。IPC 走 `piDesktop.openFile` → `shell.openPath`，带 UNC 路径和控制字符过滤。
- **在资源管理器中打开**：文件树刷新按钮旁新增文件夹图标按钮，用系统资源管理器打开当前项目根目录（cwd）（桌面端专属，浏览器隐藏）。
- **关闭全部预览标签**：文件预览 tab 栏右侧新增「✕ 全关」按钮，一次性关闭所有预览标签并收起右侧面板。
- **技能 zip 上传**：「技能 → 添加」支持上传 skill zip 包：兼容 `SKILL.md` 在根目录或单个子目录两种结构，同名冲突时报错，并做了路径穿越 + zip bomb 防护（`lib/skill-zip.ts`，单文件 10 MB、总 50 MB、最多 2000 条目）。
- **多文件上传 bug 修复**：输入框一次选多个文件时，之前只显示一个路径；现在所有路径都会正确插入。
- **浏览本地文件夹**：项目目录下拉新增「浏览本地文件夹…」项，点击弹系统原生目录选择框选项目目录（桌面端专属；浏览器因安全限制拿不到真实磁盘路径，按钮隐藏，仍可用「自定义路径…」手动输入）。

## 注意事项

- **数据目录**：默认读取 `~/.pi/agent/sessions` 下的会话文件。可通过环境变量 `PI_CODING_AGENT_DIR` 指定其他 pi agent 目录。
- **会话文件**：路径形如 `~/.pi/agent/sessions/<编码后的工作目录>/<时间戳>_<uuid>.jsonl`。
- **模型配置**：Models 面板读写 pi agent 目录下的 `models.json`，模型列表和默认模型由 pi 的配置解析得到。
- **文件访问**：文件浏览和预览面向当前选择的项目目录，以及会话中已出现过的工作目录。
- **Git worktree**：什么时候显示切换器、新建目录在哪里、删除会影响什么，见 [pi-web 里的 Worktree](./docs/worktrees.zh-CN.md)。
- **Fork 与会话内分支不同**：Fork 会创建新的 `.jsonl` 文件；“Edit from here” 是同一会话文件里的分支。

## 开发

```bash
npm install
npm run dev
```

本地开发端口为 [http://localhost:30141](http://localhost:30141)。

常用检查：

```bash
node_modules/.bin/tsc --noEmit
npm run lint
```

开发时不要运行 `next build` / `npm run build`，它会写入 `.next/`，容易影响正在运行的 dev server。发布流程再执行构建。

## 项目结构

```
app/
  api/
    agent/          # 创建/驱动 AgentSession，提供 SSE 事件流
    auth/           # OAuth 和 API key 管理
    cwd/validate/   # 自定义工作目录校验
    default-cwd/    # 获取 pi 默认工作目录
    files/          # 文件列表、读取、预览、watch
    home/           # 当前用户 home 目录
    models/         # 可用模型、默认模型、thinking levels
    models-config/  # 读写 models.json、测试模型
    sessions/       # 会话读取、重命名、删除、上下文、HTML 导出
    skills/         # skills 列表、搜索、安装、启停
    uploads/        # multipart 文件上传，写入 ${cwd}/uploads/
components/
  AppShell.tsx        # 主布局、URL 状态、顶部面板、文件标签
  SessionSidebar.tsx  # 项目选择、会话树、Explorer
  ChatWindow.tsx      # 消息区、SSE、文件拖拽、minimap
  ChatInput.tsx       # 输入栏、文件上传、模型/工具/thinking/compact/slash controls
  MessageView.tsx     # 消息、thinking、tool call/result 渲染
  ModelsConfig.tsx    # 模型和认证配置面板
  SkillsConfig.tsx    # 技能管理面板
  FileExplorer.tsx    # 文件树
  FileViewer.tsx      # 源码、diff、图片、音频、PDF、DOCX 预览
lib/
  rpc-manager.ts      # AgentSessionWrapper 生命周期和全局 registry
  session-reader.ts   # 解析 .jsonl 会话文件和分支上下文
  normalize.ts        # 规范化 toolCall 字段名
  file-access.ts      # 文件读取安全边界
  file-paths.ts       # 文件路径编码/相对路径工具
  markdown.ts         # Markdown/Mermaid/KaTeX 插件配置
  pi-types.ts         # pi 相关类型
hooks/
  useAgentSession.ts  # 会话加载、发送命令、SSE 状态机
  useAudio.ts         # 完成提示音
  useDragDrop.ts      # 图片拖拽
  useTheme.ts         # 主题切换
bin/
  pi-web.js           # npm CLI 入口
```
