# Farming

> English version: [README.md](./README.md)

[![CI](https://github.com/zhuwenzhuang/farming/actions/workflows/ci.yml/badge.svg)](https://github.com/zhuwenzhuang/farming/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/zhuwenzhuang/farming?label=release)](https://github.com/zhuwenzhuang/farming/releases)
[![npm](https://img.shields.io/npm/v/farming-code?label=npm)](https://www.npmjs.com/package/farming-code)
[![License](https://img.shields.io/github/license/zhuwenzhuang/farming)](./LICENSE)
![Node](https://img.shields.io/badge/node-%3E%3D22-339933?logo=nodedotjs&logoColor=white)
![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-555)

Farming 是一个面向 AI coding agent 的远程浏览器工作台。当前公开版本是 **Farming 2**。

它当前已经把远程 terminal、Codex / Claude Code、历史 session、项目级 agent、打开的编辑器、项目文件、搜索、轻量编辑、git review、usage 和机器状态收进同一个页面，减少人在 SSH、IDE、浏览器、监控页面和 agent 面板之间反复切换。

远程托管和多端浏览器接入是 Farming 的内核能力：agent、shell、项目文件和 git 状态都留在远程机器上持续运行；用户可以从电脑端浏览器做长时间操作，也可以从手机浏览器随时回到现场，看进度、切 session，或者做一次轻量介入。Farming 2 把这套能力组织成一个面向 Codex / Claude Code 的浏览器工作台，当前默认 UI 皮肤叫 Farming Code。

浏览器现在通过同一个后端提供两套实时 UI：`/farming/code/` 是 Farming Code，`/farming/crt/` 是原始 CRT 界面；`/farming/` 仍默认打开 Farming Code。当 Code 无法启动或渲染时，故障页面会在错误详情浮层后显示仍连接当前 Agent 的 CRT 界面，不会重启正在运行的 Agent。

产品介绍、截图和架构图见 [Farming 2 Wiki](https://github.com/zhuwenzhuang/farming/wiki)。

![Farming Code 工作台](./docs/products/code/assets/01-code-workspace.png)

> 如果你是参与本仓库开发的 AI Agent，请先阅读 [`AGENTS.md`](./AGENTS.md)，中文版本见 [`AGENTS.zh_cn.md`](./AGENTS.zh_cn.md)。

## 当前价值与长期目标

当前阶段，Farming 做的是一件很实在的事：把指挥 AI coding agent 时最常打开的工具能力放到一起。用户可以在同一个远程工作台里看 live terminal、恢复 Codex / Claude session、检查文件、搜索代码、做小修改、看 blame、看 usage 和 CPU/MEM 状态。它不是完整 IDE，也不是新的 agent 模型；它先把“观察现场”和“轻量介入”这两个高频动作变短。

远程托管是这里的关键价值。长任务可以继续跑在 Linux 开发机上，浏览器只是进入现场的入口；电脑端适合编辑、搜索、审查和长时间跟进，手机端适合离开电脑后查看状态、确认输出、发一句输入或启动一个简单 agent。这样用户不用把本地机器、远程 shell、agent session 和项目文件拆成几套上下文来回维护。

更长期的目标仍然是人的注意力管理。人类注意力有限，也没有真正的多线程处理能力；当多个 agent 同时工作时，真正消耗人的不是某一个终端，而是在不同页面、不同任务状态和不同上下文之间反复切换。

Farming 未来希望探索的是：让系统逐步判断哪些 agent 值得关注，哪些任务只是后台推进，哪些变化需要汇报，哪些地方需要人介入。Main Agent 是这个方向上的长期机制：它最终应该结合 Codex、Claude Code、shell agent 和更多工具型 agent，观察任务状态、组织子 agent、汇总进展，并减少人的上下文切换。

这部分仍在探索中，是 Farming 的终极目标；Farming 2 先把工具整合和远程工作台体验做好，作为后续 Main Agent 和多 agent 注意力管理能力的基础。

## Farming 2 带来的变化

Farming 2 是本仓库最近最大的一次产品变化。它把 Farming 从一个较轻的复古 agent monitor，推进成了更实用的远程 coding workbench，也为长期的 Main Agent 注意力管理目标补齐底座：

- 在浏览器里启动和管理 Codex、Claude、OpenCode、Qoder、bash 和 zsh session；
- 发现并恢复 Codex、Claude、OpenCode 和 Qoder 的本地历史 session，再重新接入 Farming 托管的实时 terminal；
- Codex / Claude 启动选项按 provider 收敛，不展示当前 agent 无法表达的控件；
- 在一个工作区里组织 project-scoped agents、pinned/unread sessions、Search、History 和 active terminals；
- 提供 Project Files：Open Editors、文件树、文件搜索、Monaco 编辑、Markdown/图片预览、git changes、git diff、行级 git blame；
- terminal 输出里的 `path:line` 可直接打开文件，`http(s)` URL 可直接在新标签页打开；
- Codex / Claude Composer 暴露底层运行时能表达的启动权限、模型和速度 profile；App Server Codex 会直接更新当前 thread 的权限，terminal-owned session 切换权限时才重启 CLI：已有 provider Session ID 时 resume，还没有可 resume 的 ID 时启动新会话；
- Composer 支持文本附件；粘贴或选择图片时会保存到 Farming 服务侧 `~/.farming/attachments`，并把图片路径插入消息，便于远端 Codex / Claude 读取；Farming 自动生成的图片附件默认保留 7 天后清理；
- 显示轻量 usage、context、token rate、quota 与机器状态，例如 CPU、MEM；
- 复用 Farming 的远程托管和多端浏览器接入能力，让桌面和手机访问同一套远程 Linux 服务。

具体截图、安装方式和产品说明见 [Farming 2 产品介绍](./docs/products/code/README.zh_cn.md)。

## 快速开始

默认推荐通过 npm 安装，把 Farming 运行在已经能正常执行 `codex` 或 `claude` 的开发机上。

```bash
npm install --global farming-code
farming daemon
```

默认端口是 `6694`，浏览器路径是 `/farming`，配置目录是 `~/.farming`，并默认启用 token auth。首次鉴权启动会生成一个随机但可读的口令，并保存到 `~/.farming/.session-token`；之后重启和升级都会复用这个 token，除非显式设置 `FARMING_TOKEN`。在中文时区默认是中文俳句式口令，日本时区默认是日文俳句式口令，其它时区默认是英文短语。启动日志会打印类似下面的 URL：

```text
http://linux-host:6694/farming?token=<startup-token>
```

把完整 URL 复制到桌面或手机浏览器中打开，点击 `New Agent`，选择 `Codex`、`Claude Code`、`bash` 或 `zsh`，填入 workspace，就可以进入远程工作台。

## 下载与部署形态

npm 包是默认发布形态；也可以从 [GitHub Releases](https://github.com/zhuwenzhuang/farming/releases) 下载手动安装产物。

Farming 2 当前有三种实际部署形态：

| 环境 | 产物 | 适用场景 |
| --- | --- | --- |
| macOS 与 Linux | `npm install --global farming-code` | 默认路径，需要 Node.js 22+，并且系统 runtime 能加载 `node-pty`。 |
| 不使用 npm 的环境 | GitHub Releases 平台 CLI | 手动安装，升级也需要手动替换。 |
| 目录部署 | `farming-<version>-<platform>-<arch>.tar.gz` | 包含 production dependencies 和 launcher 脚本的 App Bundle，直接使用目标系统 runtime。 |
| 老 Linux x64（glibc < 2.28） | `farming-<version>-linux-x64-legacy-glibc228.tar.gz` | GitHub Release 随附的兼容 App Bundle，包含固定校验的 glibc 2.28 runtime；仅在系统 runtime 过旧时启用，但目标机仍需有 Node.js 22 可执行文件。 |
| 自建老 Linux 包 | `farming-<version>-linux-x64-glibc217.tar.gz` | 独立构建的兼容包；基于 glibc 2.17 重新编译 `node-pty`，但仍要求目标机有可用的 Node.js runtime。 |

如果要通过 Farming 启动 Codex 或 Claude Code，同一台机器上仍然需要提前安装并登录对应 CLI。Farming 托管的是这些 CLI session，不替代它们自己的安装和账号流程。

## 架构

```text
浏览器皮肤
  React + Vite + Monaco + terminal renderer
        |
        | HTTP / WebSocket
        v
Farming 内核
  Express server + token auth + agent manager + session providers
        |
        | native pty host + session engine
        v
执行环境
  bash / zsh / Codex / Claude Code
```

内核负责 agent 生命周期、WebSocket 状态同步、session engine、workspace 文件 API、历史 session provider、模型/profile 发现、usage 采集和配置管理。产品皮肤负责把这些能力组织成不同体验。新的交互 session 默认使用 native pty host：node-pty agent 进程放在独立 host 进程里，Farming server 和浏览器可以重新连回仍存活的 terminal。native pty host 默认会跨 Farming server 重启保留；当没有 live session 和 client 后会在空闲宽限期后退出。只有希望 host 跟随 server 一起退出时才设置 `FARMING_NATIVE_PTY_HOST_PERSIST=0`。只有调试进程内 node-pty engine 时才设置 `FARMING_SESSION_ENGINE=local`。

浏览器 terminal renderer 默认使用 xterm.js。旧的 Ghostty web renderer 仍保留为显式调试路径，可通过 `localStorage.farmingTerminalEngine = 'ghostty'` 切换。

## 安装与发布

Farming 2 最适合运行在一台 Linux 开发机上；这台机器里应当已经能在普通 SSH shell 中正常运行 Codex 或 Claude Code。

默认安装方式：

```bash
npm install --global farming-code
farming daemon
```

npm 安装后可在 **设置 → 更新** 一键升级。Farming 会先在旧服务仍运行时完成 npm 安装，安装成功后才重启；如果新服务无法启动，会尝试恢复旧版本。等价的手动命令是 `npm install --global farming-code@latest`。

兼容发布形态主要有两种：

- 单文件 CLI：适合现代 Linux 和 macOS，拿到一个 `farming` 可执行文件后直接运行。
- App bundle：适合目录式部署；包是一个 tarball，解压后通过根目录 `./farming` 脚本启动，脚本负责 Node heap 和运行环境。

源码远程部署脚本是开发团队把当前 checkout 部署到固定 Linux 机器的便捷路径。

如果要启动 Codex 或 Claude Code，目标机器上还需要提前安装并登录对应 CLI，确保在普通 SSH shell 中直接运行 `codex` 或 `claude` 能进入交互。

### 从源码打包

构建单文件 CLI：

```bash
npm install
npm run release:cli
```

构建可解压运行的 app bundle：

```bash
npm install
npm run release:app
```

`release:app` 会生成 `releases/<version>/farming-<version>-<platform>-<arch>.tar.gz`，包内包含已经构建好的前端、production dependencies 和根目录启动脚本，使用目标系统 runtime。

如果目标是 glibc 低于 2.28 的 Linux x64，构建带固定 glibc 2.28 runtime 的发布资产：

```bash
npm run release:app:legacy-linux
```

它会生成 `farming-<version>-linux-x64-legacy-glibc228.tar.gz`。安装时 runtime 解压到 `~/.farming/glibc228`，且仅在旧 Linux 上启用；现代 Linux 和 macOS 包不受影响。

如果只需要将 `node-pty` 编译到更低 ABI，仍可在干净的 Linux x64 构建环境中准备 glibc 2.17、Node.js 22+、GCC/G++、Make 和 Python 3，然后运行：

```bash
npm run release:app:linux-compat
```

该命令会强制从源码编译 `node-pty`，并在其 native module 依赖高于 glibc 2.17 时拒绝产物。远程安装使用 `FARMING_REMOTE=user@host FARMING_RELEASE_TARBALL=<archive> npm run release:remote:linux-compat`。这个 ABI 包仍使用目标机器自己的 Node.js 和 libc。

如果已经在配置好的 Linux x64 构建机上准备了干净源码，`scripts/build-linux-compat-release-on-builder.sh` 可以继续自动完成容器构建、ABI 校验、打包后 bash Agent 冒烟和产物输出。通过 `FARMING_COMPAT_IMAGE` 指定构建机上已经存在的镜像。脚本使用 `--pull=never`，并默认关闭容器网络，以复用已有镜像和缓存，避免发布时隐式下载构建环境；只有确实需要主动刷新缓存时才设置 `FARMING_COMPAT_ALLOW_NETWORK=1`。

### 启动单文件 CLI

拿到对应平台的单文件 `farming` 后：

```bash
chmod +x farming
./farming daemon
```

它会优先监听 `6694`、挂载到 `/farming`，并自动创建 `~/.farming/settings.json`、token 文件和必要运行目录；如果未显式指定端口且 `6694` 已占用，会自动上探选择可用端口。启动后终端会打印带 token 的浏览器 URL。前台运行可直接执行 `./farming` 或 `./farming start`；常用管理命令是 `./farming status`、`./farming logs`、`./farming stop`。

### 启动 app bundle

普通 Linux 上：

```bash
tar -xzf farming-<version>-linux-x64.tar.gz
cd farming-<version>-linux-x64
./farming
```

标准包的启动脚本直接使用目标机器的普通 Node.js 和 native runtime。glibc 低于 2.28 的 Linux x64 请改用 `-legacy-glibc228` 包；该兼容包只在需要时启用内置 runtime。

App bundle 常用命令：

```bash
./farming status
./farming logs
./farming stop
./farming start
./farming url
```

### 源码远程部署

如果本机可以 SSH 到目标 Linux，且已经配置 `config/farming.deploy.env`：

```bash
npm run release:remote
```

这条路径会从当前源码 checkout 构建 app bundle、上传到远端、安装并启动服务，适合团队开发和 dogfood。

### 开发调试

只在本地开发 Farming 本身时，才需要直接启动源码服务：

```bash
npm install
npm start
```

服务启动后会打印一个 token URL。仅在可信本地开发环境中，可以关闭 token 校验：

```bash
npm run start:no-auth
```

远程安装和 release 细节见 [`docs/products/code/README.zh_cn.md`](./docs/products/code/README.zh_cn.md)。

## 配置

运行时配置存储在 `~/.farming/settings.json`。
Agent session 元数据单独存储在 `~/.farming/sessions/`。Farming 使用稳定的
`fsess_*` 文件作为自己的 Agent 记录；live `agent-...` id 以及 Codex / Claude
provider session id 都作为这些记录上的元数据保存。主页面 Projects membership
存放在 `sessions/index.json`，`mainPageSessionKeys` 只是为兼容 API 暴露出来的投影。
归档 run/history 存储在 `~/.farming/history/runs.json`，不属于 `settings.json`。
主题覆盖配置、启动 token、server pid/state/log 文件和 native pty host 日志也都在同一个 config 目录下。

主要用户配置项：

- `defaultLaunchAgent`：New Agent 默认 provider，目前是 `codex` 或 `claude`；
- `agentLaunchProfiles.codex`：Codex 的启动权限、模型、reasoning、service tier profile；
- `agentLaunchProfiles.claude`：Claude 的启动 permission、model、effort profile；
- `agentHomes`：管理 Codex、Claude、OpenCode、Qoder 的 agent home 元数据，每项只包含 `id` 和 `path`；每个 provider 都保留不可删除的 `default` home；
- `workspaceHistory`：New Agent 启动时使用的最近 workspace；
- `dangerouslySkipAgentPermissionsByDefault`：是否默认让支持的 coding agent（如 Codex、Claude、OpenCode、Qoder、Qwen、Aider、GitHub Copilot CLI、Amazon Q）使用各自最激进的权限绕过启动 flag。

Native terminal session 由 Farming pty host 托管，通过从 `configDir` 派生的本地 socket 连接。默认保留 host 以支持 server 重启恢复；最后一个 live session 和 client 都消失后，host 会在短暂空闲宽限期后自退出。后续 terminal runtime 工作应面向 native pty host 和 xterm.js 链路。

更新行为跟随安装方式：npm 安装读取 npm registry 的版本并在 **设置 → 更新** 提供一键升级；源码 checkout 通过 Git 更新；单文件 CLI 手动替换。App bundle 可以配置可信的 HTTP(S) 包目录或 manifest URL，升级器只会提供与当前 OS、CPU 架构匹配的 bundle，并在安装前校验 checksum。App bundle 的 Update URL 保存在 `~/.farming/settings.json` 的 `updateUrl` 字段中。

最简单的更新源是一个以 `/` 结尾的 HTTP(S) 目录 URL，目录里列出带平台标记的 `farming-<version>-<platform>-<arch>.tar.gz` app bundle，并为每个 bundle 提供相邻的 `<bundle>.sha256` 文件。Farming 会在解压前校验所选 bundle 的 SHA-256 与归档路径，再运行 installer。

部署配置模板位于 `config/`：

- `config/farming.deploy.env.example`
- `config/farming.install.env.example`

真实 `.env` 配置文件会被 git 忽略。

## 安全

Farming 可以控制目标机器上的真实 terminal 和 agent 进程，适合运行在可信开发机和可信网络中。不要在没有 VPN、SSH tunnel、HTTPS 反向代理或网络 ACL 等额外安全层的情况下直接暴露到公网。

启动 token 会同时保护 HTTP 页面和 WebSocket 连接。它在首次鉴权启动时随机生成，持久保存到 `~/.farming/.session-token`，并在后续重启和升级中复用。生成的新 token 刻意做成比长十六进制串更容易复制的可读口令：中文时区默认生成中文俳句式口令，日本时区默认生成日文俳句式口令，其它时区默认生成英文短语；也可以用 `FARMING_TOKEN_LOCALE=zh|ja|en|auto` 显式指定新 token 的生成语言。

`FARMING_DISABLE_AUTH=1` 只应该用于可信本地开发环境。terminal-owned 的 Codex / Claude session 切换权限时会用所选 flag 重启 CLI：已有 provider Session ID 时会 resume，还没有可 resume 的 ID 时启动新会话。App Server Codex 则直接在当前 thread 上更新审批和 sandbox 策略，不启动 CLI。

安全上报和部署注意事项见 [SECURITY.md](./SECURITY.md)。

## 排错

- **Codex 或 Claude Code 无法启动**：先确认同一台机器上对应 CLI 已安装、已登录，并能在普通 shell 中直接运行。
- **Native PTY 无法启动**：检查目标系统的 Node.js 与打包的 `node-pty` runtime 是否兼容；glibc 低于 2.28 的 Linux x64 请使用 `-legacy-glibc228` 包。
- **端口占用**：可以传 `--port <port>`；如果没有显式指定端口，默认 daemon 启动会自动上探选择可用端口。
- **手机访问不了**：使用启动日志里打印的 Network URL，并确认手机能访问目标开发机。
- **找不到 token URL**：运行 `./farming url`，或查看 `./farming logs`。

## 目录结构

```text
farming/
├── .gitattributes          # 源码归档 export-ignore 规则
├── backend/                 # Node.js server、session engine、agent manager、session/history/usage/file/slash-command APIs
├── src/                     # React + Vite 前端；Farming Code 皮肤与交互 helper 位于 src/components/code/
├── frontend/skins/crt/      # 独立的实时 CRT 入口、应用逻辑与视觉效果
├── frontend/*.js            # 多皮肤共享的 terminal/session 浏览器 bridge
├── docs/
│   ├── products/code/       # Farming 2 产品介绍、Farming Code 皮肤截图、安装说明和验收 dogfood 方案
│   └── products/crt/        # CRT 皮肤 README 和布局说明
├── config/                  # 部署 / 安装配置模板
├── scripts/                 # 部署、release、测试、产品截图和辅助脚本
├── tests/e2e/               # Playwright 展示与浏览器流程测试
├── reference/               # 外部项目源码、工具链和调研 walkthrough；不作为 Farming 运行时依赖
├── pkg.config.cjs           # 平台 CLI 应用打包配置（@yao-pkg/pkg + legacy pkg）
└── bin/farming              # 开发态产品 CLI；发布后二进制也叫 farming
```

公开产品文档现在从根 README 和 `docs/products/` 下的皮肤 README 进入。`releases/` 是本地打包输出目录，不提交到源码仓库。

## 测试

运行主检查：

```bash
npm run check
```

常用单项命令：

```bash
npm test
npm run typecheck
npm run lint
npm run test:e2e:playwright
```

Playwright 测试会在合适位置使用 fake coding-agent executable，常规 UI 回归不会消耗真实 Codex / Claude 额度。

## 作者

- [zhuwenzhuang](https://github.com/zhuwenzhuang)
- [l4wei](https://github.com/l4wei)

## 贡献

欢迎提交 issue 和 pull request。开始前请阅读 [CONTRIBUTING.md](./CONTRIBUTING.md)；如果改动影响用户可见行为、打包方式或部署方式，请同步更新 README、产品文档和相关验收说明。

## License

MIT
