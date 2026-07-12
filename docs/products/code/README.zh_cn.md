# Farming 2

> English version: [README.md](./README.md)

浏览器里的远程 Codex / Claude Code 工作台。

Farming 2 运行在一台 Linux 开发机上，把 Web Terminal、AI coding agent、项目文件、搜索、轻量编辑、git blame 和运行状态放到同一个浏览器页面里。真正的命令和 agent 仍然跑在服务器上，浏览器负责进入现场、观察进度、检查文件，并在需要时介入。当前默认 UI 皮肤叫 Farming Code。

初版视觉只提供白色系界面，不提供黑色系或跟随系统外观切换。

打开 **设置 → 界面**，可以从 Farming Code 切换到 **Farming CRT**。两套皮肤连接同一组后端 Agent，切换界面不会重启或复制 Agent 进程；Farming CRT 的 UI Theme 设置中也提供返回入口。

![Farming Code 工作台](assets/01-code-workspace.png)

上面的工作台截图展示了 Farming Code 的核心形态：一个远程浏览器页面里同时有 live Codex terminal、项目文件、usage 状态和 follow-up 控件。

## 核心能力

- **Web Terminal**：在浏览器里启动 bash 或 zsh，背后是真实的 Linux PTY。
- **Codex / Claude Code 托管**：把 CLI coding agent 跑在服务端，之后可以从浏览器重新接入。稳定的 Codex session 还可以使用基于 Codex 本地历史的结构化 Chat 视图，同时保留 raw Terminal 作为兜底。
- **项目文件**：浏览文件树，搜索文件名或内容，打开 `path:line`，编辑文本文件并保存。
- **Git Blame**：在代码旁查看作者和提交时间，接近 IDE 的 annotate 体验。
- **运行状态**：查看 token 速率、CPU、内存和输出活动，不用另开监控页面。
- **手机浏览器访问**：离开电脑后，也可以在手机上查看 agent 状态、打开终端、启动新 agent 或做轻量介入。
- **可选 Main Agent**：当你需要一个 agent 去启动、观察、推进和总结其他 agent 时，可以使用 Main Agent。

后端还提供实验性的 [ACP runtime](acp-runtime.zh_cn.md)，用于 Codex、Claude Code、OpenCode 和 Qoder 的结构化 Session。Chat UI 对历史加载和实时更新消费同一条有序 ACP entry stream，Terminal 则继续保持为隔离的 PTY runtime。

## Agent 状态推断

Farming Code 把进程生命周期、Agent 类型和当前 turn 是否活跃分开判断。直接启动的 coding agent 会保留启动命令对应的类型，普通回答正文即使提到其他 provider，也不能改变它的能力；`bash` 或 `zsh` row 只有在 viewport 出现足够强的 TUI 证据时，才会切换成内层 Codex 或 Claude Code。

后端统一产出一份结构化 terminal status。它优先识别 provider 自己的实时控制面：Codex / Claude 的 interrupt 提示、OpenCode 的运行 footer，以及 Qoder / Qwen 带 `esc to cancel` 的 loading 行。更晚出现的 idle footer 或输入提示会覆盖旧的 `Working` / `Thinking` 文本；权限选择器表示等待用户介入，不算仍在计算。Shell session 使用 Farming 的 start / finish marker，并用可见 prompt 修正陈旧的 busy 状态。普通输出里的 `working`、`thinking`、`Claude` 或 `Codex` 等词不再单独作为判断依据。

前端用同一份结构化结果驱动侧栏 spinner 和输入框的 interrupt 动作。Terminal title 只作为对应 provider 的辅助证据，其他 CLI 的 spinner 风格 title 不会再被一律当成 Codex。

## Agent 行身份

Farming Code 的项目列表只保留两类行身份：

- Codex 和 Claude 行使用 provider 自己的 resume id，格式是 `agent-session:<provider>:<id>`。
- Bash 和 zsh 行使用 shell 启动时分配的 runtime agent uuid。
- 归档 bash 或 zsh 行会直接销毁这次 shell runtime，不会写入 History。

新启动 Claude 时，Farming 会先生成 uuid 并通过 `--session-id` 传给 Claude。新启动 Codex terminal session 时，稳定 resume id 要等首个可落盘 rollout item 写入后才出现，所以 Farming 会先给 live 行一个 `tmp_uuid...` 临时 provider id；这个临时 id 不进入 History 或 `mainPageSessionKeys`，等 Codex 本地 metadata 出现后再替换成真实 rollout id。历史恢复启动的 session 一开始就知道 id；runtime session 恢复时读取 Farming 写入的 provider-session metadata。

运行中切换权限时，Farming 会用所选启动 flag 重启 CLI。已有稳定 provider Session ID 时 resume 同一会话；新 Codex 还没有稳定 ID 时，则停止临时 runtime 并启动新会话。界面会在原位置显示切换中，并保持当前 agent 以及 Chat / Terminal 视图，不会回退到其他 agent。

## Agent 排序

每个运行中的 Agent 都有持久化的 Project 内顺序。新建 Agent 出现在所属 Project 最前面；桌面端可以在同一 Project 内或 Pinned 列表内拖动 Agent。置顶后 Agent 会离开 Project 列表并追加到独立的 Pinned 列表末尾；取消置顶后恢复到原来的 Project 位置。Farming 也会持久化 provider 历史 Session 的置顶状态；浏览器刷新、权限重启和 runtime 恢复都会保留这些信息。

## 产品导览

### 启动新 Agent

![启动新 Agent](assets/02-start-agent-picker.png)

Farming 可以从浏览器启动 Codex、Claude Code、bash 和 zsh session；真正的命令仍然运行在开发机上。

![选择 Workspace](assets/03-start-agent-workspace.png)

最近 workspace 和手动 workspace 输入让启动路径足够明确：先选仓库，再选 agent 类型，Farming 会把 session 打开在同一个工作台中。

### 项目文件与编辑

![文件编辑](assets/04-files-editor-blame.png)

Farming 2 不试图替代完整本地 IDE。它提供的是监督 AI coding agent 时最常用的动作：浏览项目树、搜索文件、打开标签页、检查源码、查看 git blame、做一个小修改，然后回到 agent 工作流。

### 手机端

![手机端 Agent 对话](assets/05-mobile-agent-chat.jpg)

![手机端文件侧栏](assets/06-mobile-files-sidebar.jpg)

手机端不是桌面界面的简单缩小版。它一次聚焦一个 agent terminal 或文件视图，把项目导航、agents、搜索和文件放进抽屉。适合在通勤、会议间隙或离开电脑后快速看进度、切换 agent、启动一个新 agent，或者给正在运行的 terminal 发一句简短输入。

复杂的多文件编辑、长时间代码审查和大范围 git blame 仍然更适合桌面端；手机端的重点是远程接入和轻量监督。

完整手机端使用路径和验收故事见 [Farming 2 手机端使用介绍](mobile-guide.zh_cn.md)。

功能组件、真实 Codex / Claude smoke、人设深测和长时间 dogfood 的验收划分见 [Farming 2 验收 Dogfood 测试方案](test/acceptance-dogfood-plan.zh_cn.md)。

## 安装

Farming 2 默认推荐以平台 CLI 应用发布。Linux 和 macOS 都是一个名为 `farming` 的可执行程序；它内置 Farming server、前端资源和必要运行时代码，不要求用户先解包源码目录。

App bundle 是目录式部署的备选形态：解压后通过根目录 `./farming` 脚本启动，包内包含 production dependencies。它直接使用目标机器的普通 Node.js 和 native runtime；Farming 不再携带或安装私有系统 C 库。

### 前置条件

运行 Farming 2 的机器需要：

- git
- bash 或 zsh
- 如果要启动 Codex 或 Claude Code，同一台机器上还需要提前准备好对应 CLI：CLI 已安装、账号已登录，并且在普通 SSH shell 里直接运行 `codex` 或 `claude` 能正常进入交互。

Farming 2 不替代 Codex / Claude Code 自己的安装和登录流程。它托管的是已经能在服务器上运行的 CLI session。

### 从平台 CLI 应用启动

从 release 页面下载匹配当前机器的平台产物，或在源码仓库中用 `npm run release:cli` 本地构建。产物命名形态如下：

```text
farming_<release>_linux_amd64
farming_<release>_linux_arm64
farming_<release>_darwin_arm64
```

放到目标机器后执行：

```bash
cp ./farming_2_linux_amd64 farming
chmod +x farming
./farming daemon
```

默认行为：

- 监听端口：优先 `6694`；未显式指定端口且 `6694` 已占用时，自动上探选择可用端口
- 浏览器路径：`/farming`
- 配置目录：`~/.farming`
- 首次启动自动创建 `~/.farming/settings.json`
- 首次鉴权启动自动生成 token，保存到 `~/.farming/.session-token`，之后重启和升级复用，并在启动日志打印完整 URL
- 自动按机器内存为 server 子进程设置 Node heap；不会把该限制传给子 agent
- 单文件 CLI 适合 Linux 和 macOS；标准发布形态依赖目标系统提供兼容的 native runtime。GitHub Release 还会提供 `farming-<release>-linux-x64-legacy-glibc228.tar.gz`，面向 glibc 低于 2.28 的 Linux x64；它带有固定 runtime，安装器只在旧系统上启用。

npm 是默认发布方式：`npm install --global farming-code` 后运行 `farming daemon`。npm 安装会从 registry 读取可用版本，在 **设置 → 更新** 中一键升级；旧服务会保持运行直到安装成功，新服务启动失败时会尝试恢复旧版本。源码 checkout 通过 Git 更新，单文件 CLI 手动替换。App bundle 仍可配置 Update URL，升级包按 OS/CPU 匹配并校验 checksum。该设置面板也用于管理各 provider 的 **Agent Homes**。

最简单的更新源是一个以 `/` 结尾的 HTTP(S) 目录 URL，目录里列出带平台标记的 `farming-<version>-<platform>-<arch>.tar.gz` app bundle，并为每个 bundle 提供相邻的 `<bundle>.sha256` 文件。Farming 会在解压前校验所选 bundle 的 SHA-256 与归档路径。

启动日志会打印浏览器入口，例如：

```text
http://linux-host:6694/farming?token=随机生成的俳句口令
```

把完整 URL 复制到浏览器打开即可。第一次访问成功后，服务端会写入 `farming_token` Cookie，后续刷新页面和 WebSocket 重连会自动复用认证。

常用管理命令：

```bash
./farming status
./farming logs
./farming stop
./farming start
```

如需覆盖默认值，可以通过命令行参数完成，不需要先写配置文件：

```bash
./farming daemon --port 7788 --base-path /farming --config-dir ~/.farming
```

显式传入 `--port` 时 Farming 会严格使用该端口；只有无参数默认启动时才自动避开已占用端口。

### 构建平台 CLI 应用

在源码仓库中构建当前平台产物：

```bash
npm install
npm run release:cli
```

输出目录示例：

```text
releases/2/farming_2_darwin_arm64
releases/2/farming_2_checksums.txt
releases/2/manifest.json
```

默认会构建当前平台产物。也可以显式指定目标：

```bash
FARMING_CLI_TARGETS=node22-linux-x64 npm run release:cli
```

macOS 和 Linux 单文件 CLI 产物都使用 `@yao-pkg/pkg` 的现代 Node runtime。Linux 单文件 CLI 在 CI 中验证 server 启动；Linux native PTY / agent 启动通过 app bundle 做完整 smoke。打包态 Darwin 会把 `node-pty` 的 `spawn-helper` 释放到 `~/.farming/runtime/node-pty/<platform-arch>/`。所有发布形态都依赖目标系统提供兼容的 native runtime。

`npm run release:cli` 使用 Vite 构建前端，再通过 `scripts/bundle-cli-runtime.js` 用 esbuild 将后端 runtime bundle/minify 为临时入口，最后按目标平台选择 `@yao-pkg/pkg` 或 legacy `pkg` 生成可执行文件。发布产物里不包含仓库的 `backend/`、`src/`、测试或脚本源码；服务端代码进入二进制，浏览器前端只包含构建后的 `dist/` 资源。`node-pty` native addon 和 `spawn-helper` 作为显式 assets 进入包，pkg 不执行 native build。

发布脚本不会生成 sourcemap；pkg 仍使用 `bytecode: true` 和 `fallbackToSource: false`。打包完成后会对最终二进制做基础 `strings` 扫描，发现源码路径、测试名或内部文档标记会直接失败。

构建后可用 smoke 脚本验证一个全新的用户冷路径：

```bash
npm run release:cli:smoke -- releases/2/farming_2_linux_amd64
```

该脚本使用干净 `HOME` 启动二进制，验证自动创建 `~/.farming/settings.json` / token、HTTP token 入口、`spawn` / `send` / `output` / `kill` / `stop` 控制链路。

### 构建 app bundle

在源码仓库中构建可解压运行的 app bundle：

```bash
npm install
npm run release:app
```

输出示例：

```text
releases/2/farming-2-linux-x64.tar.gz
```

### 在 Linux 上安装 app bundle

如果已经拿到别人构建好的 app bundle，例如 `farming-2-linux-x64.tar.gz`，上传到目标 Linux 后直接解压启动：

```bash
tar -xzf farming-2-linux-x64.tar.gz
cd farming-2-linux-x64
./farming
```

默认包内已经包含 production dependencies。无参数运行会直接准备运行环境、写入 `.farming-install-env` 并启动服务；启动日志会打印带 token 的浏览器 URL。

Linux x64 的 glibc 低于 2.28 时，下载并按同样步骤解压 `farming-<release>-linux-x64-legacy-glibc228.tar.gz`。安装器会把包内 runtime 解压到 `~/.farming/glibc228`，仅用于该旧系统。

常用命令：

```bash
./farming status
./farming logs
./farming stop
./farming start
./farming url
```

如果打包时显式设置 `FARMING_BUNDLE_NODE_MODULES=0`，或者包内缺少依赖，无参数运行会自动走一次 `./farming install` 来安装 production dependencies。

### 从源码远程部署

如果你从源码仓库部署，并且本机可以 SSH 到目标 Linux 开发机：

```bash
git clone <repo-url> farming
cd farming
npm install
cp config/farming.deploy.env.example config/farming.deploy.env
```

编辑 `config/farming.deploy.env`：

```bash
FARMING_REMOTE=user@linux-host
FARMING_REMOTE_DIR=/home/user/farming
FARMING_REMOTE_PORT=6694
FARMING_REMOTE_BASE_PATH=/farming
```

部署：

```bash
npm run release:remote
```

这条命令会构建前端、生成 app bundle tarball、上传到 Linux、安装 production dependencies、启动服务，并打印带 token 的浏览器 URL。它适合开发团队把当前 checkout 部署到固定远端。

如果团队已经维护好了 `config/farming.deploy.env`，源码部署就只需要：

```bash
npm run release:remote
```

## 快速开始

1. 打开安装命令打印出来的 token URL。
2. 点击 `New Agent`。
3. 选择 `Codex`、`Claude Code`、`bash` 或 `zsh`。
4. 填写 workspace，例如 `/home/user/project`。
5. 点击 `Start`。

agent 启动后，浏览器工作台会显示 live terminal、agent 列表、Project 文件入口和运行状态。

同一个 URL 可以在桌面浏览器和手机浏览器中打开。手机需要能访问运行 Farming 2 的 Linux 机器；如果在同一可信网络或同一 Wi-Fi 中，通常直接使用启动日志里的 `Network` URL。第一次用 token URL 打开后，浏览器会保存 Cookie，后续刷新或重新打开页面会自动接入。

## 配置文件

最终用户通常不需要手写配置文件。`farming` CLI 默认使用 `~/.farming/settings.json`；文件不存在时会自动创建默认配置。

源码远程部署仍可使用 `config/farming.deploy.env` 承载复杂 SSH 目标和远程目录。仓库内提供 `.example` 模板，真正的 `.env` 配置文件会被 git 忽略，避免机器名、安装路径和 demo 配置被误提交。

## Main Agent

Main Agent 是可选能力。可以把它理解成 Farming 2 工作台里的“现场协调员”。

当你同时有多个 agent 或多个相关子任务时，Main Agent 可以帮助启动新的 agent、观察输出、继续发送输入，并把进度整理后汇报给你。第一天使用 Farming 2 不需要理解这个机制；你可以先把它当作浏览器里的远程 terminal 和 Codex / Claude Code 工作台，等真的需要协调多个 agent 时再启用 Main Agent。

## 架构

```text
浏览器工作台
  React + Vite + Monaco Editor + terminal renderer
        |
        | HTTP / WebSocket
        v
Node.js 服务端
  Express + WebSocket + token auth + agent manager + workspace file service
        |
        | session engine
        v
Linux 执行环境
  bash / zsh / Codex / Claude Code
```

后端负责提供浏览器应用、校验 HTTP 和 WebSocket token、管理 agent 生命周期、转发 terminal 输入输出，并提供 workspace 文件 API。

Farming Code 默认使用 xterm.js 作为浏览器 terminal renderer。旧的 Ghostty web renderer 仍作为显式调试选项保留，可通过 `localStorage.farmingTerminalEngine = 'ghostty'` 切换。

对于稳定的 Codex provider session，Farming 可以从 Codex rollout 历史渲染 Chat 视图：用户请求、最终答复、默认折叠的工作过程摘要，以及文件修改结果卡片。这个视图是对 Codex 历史的重放，不替代 terminal IO；需要精确 CLI 行为或 live 边界情况时仍可以切回 raw Terminal。

本地 session engine 基于 `node-pty`。文件搜索优先使用系统 `rg`，缺失时使用 npm `ripgrep` fallback。git diff 和 git blame 复用目标机器上的 `git`，不在 Farming 2 内部重写这些能力。

## 安全说明

Farming 2 首次鉴权启动时会生成随机 token，保存到 `~/.farming/.session-token`，并在后续重启和升级中复用。token 同时保护 HTTP 页面和 WebSocket 连接。`FARMING_TOKEN_LOCALE=auto` 控制新 token 的生成语言：中文时区生成中文 5-7-5 俳句式口令，日本时区生成日文 5-7-5 俳句式口令，其它时区生成英文 passphrase；也可显式设置 `FARMING_TOKEN_LOCALE=zh|ja|en`。短语 token 比长十六进制串更容易复制。

Farming 2 适合部署在可信开发机或可信内网中。不要在没有额外安全层的情况下直接暴露到公网。

安全上报和部署注意事项见 [SECURITY.md](../../../SECURITY.md)。
