# Farming

> English version: [README.md](./README.md)

[![CI](https://github.com/zhuwenzhuang/farming/actions/workflows/ci.yml/badge.svg)](https://github.com/zhuwenzhuang/farming/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/zhuwenzhuang/farming?label=release)](https://github.com/zhuwenzhuang/farming/releases)
[![npm](https://img.shields.io/npm/v/farming-code?label=npm)](https://www.npmjs.com/package/farming-code)
[![License](https://img.shields.io/github/license/zhuwenzhuang/farming)](./LICENSE)
![Node](https://img.shields.io/badge/node-%3E%3D22-339933?logo=nodedotjs&logoColor=white)
![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-555)

Farming 是一个面向 AI coding agent 的远程浏览器工作台。当前公开版本是 **Farming 2**。

它当前已经把远程 terminal、Codex / Claude Code、历史 session、项目文件、搜索、轻量编辑、git blame、usage 和机器状态收进同一个页面，减少人在 SSH、IDE、浏览器、监控页面和 agent 面板之间反复切换。

远程托管和多端浏览器接入是 Farming 的内核能力：agent、shell、项目文件和 git 状态都留在远程机器上持续运行；用户可以从电脑端浏览器做长时间操作，也可以从手机浏览器随时回到现场，看进度、切 session，或者做一次轻量介入。Farming 2 把这套能力组织成一个面向 Codex / Claude Code 的浏览器工作台，当前默认 UI 皮肤叫 Farming Code。

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

- 在浏览器里启动和管理 `codex`、`claude`、`bash`、`zsh` session；
- 恢复 Codex / Claude 本地历史 session，并重新接入 Farming 托管的实时 terminal；
- Codex / Claude 启动选项按 provider 收敛，不展示当前 agent 无法表达的控件；
- 在一个工作区里组织 project-scoped agents、pinned/unread sessions、Search、History 和 active terminals；
- 提供 Project Files：文件树、文件搜索、Monaco 编辑、Markdown 预览、git diff、行级 git blame；
- terminal 输出里的 `path:line` 可直接打开文件，`http(s)` URL 可直接在新标签页打开；
- Composer 支持文本附件；粘贴或选择图片时会保存到 Farming 服务侧 `~/.farming/attachments`，并把图片路径插入消息，便于远端 Codex / Claude 读取；Farming 自动生成的图片附件默认保留 7 天后清理；
- 显示轻量 usage 与机器状态，例如 token rate、CPU、MEM；
- 复用 Farming 的远程托管和多端浏览器接入能力，让桌面和手机访问同一套远程 Linux 服务。

具体截图、安装方式和产品说明见 [Farming 2 产品介绍](./docs/products/code/README.zh_cn.md)。

## 快速开始

最常见的使用方式，是把 Farming 运行在已经能正常执行 `codex` 或 `claude` 的 Linux 开发机上。

```bash
chmod +x farming
./farming daemon
```

默认端口是 `6694`，浏览器路径是 `/farming`，配置目录是 `~/.farming`，并默认启用 token auth。首次鉴权启动会生成一个随机但可读的口令，并保存到 `~/.farming/.session-token`；之后重启和升级都会复用这个 token，除非显式设置 `FARMING_TOKEN`。在中文时区默认是中文俳句式口令，日本时区默认是日文俳句式口令，其它时区默认是英文短语。启动日志会打印类似下面的 URL：

```text
http://linux-host:6694/farming?token=<startup-token>
```

把完整 URL 复制到桌面或手机浏览器中打开，点击 `New Agent`，选择 `Codex`、`Claude Code`、`bash` 或 `zsh`，填入 workspace，就可以进入远程工作台。

## 下载与部署形态

可以从 [GitHub Releases](https://github.com/zhuwenzhuang/farming/releases) 下载发布产物，也可以从源码本地构建。

Farming 2 当前有三种实际部署形态：

| 环境 | 产物 | 适用场景 |
| --- | --- | --- |
| 现代 Linux | `farming_2_linux_amd64` / `farming_2_linux_arm64` | 目标机器 glibc 兼容，希望一个 binary 直接运行。 |
| 老 Linux | `farming-2.tar.gz` | CentOS 7 / glibc 2.17 这类机器，需要 app bundle launcher 和包内 glibc 2.28 runtime。 |
| macOS | `farming_2_darwin_arm64` | 本机开发、演示和轻量使用。 |

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

发布形态主要有两种：

- 单文件 CLI：适合现代 Linux 和 macOS，拿到一个 `farming` 可执行文件后直接运行。
- App bundle：适合低 glibc Linux，例如 CentOS 7 / glibc 2.17；包是一个 tarball，解压后通过根目录 `./farming` 脚本启动，脚本负责私有 glibc、Node heap 和运行环境。

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

`release:app` 会生成 `releases/<version>/farming-<version>.tar.gz`，包内包含已经构建好的前端、production dependencies、根目录启动脚本和低 glibc Linux 使用的 `vendor/glibc228-lib.tar.gz`。

如果打包机不能访问默认 glibc 2.28 来源，或团队需要使用内部镜像，可以用 `FARMING_GLIBC_BUNDLE=/opt/farming/glibc228-lib.tar.gz` 指定打包来源；这只是替换来源，app bundle 仍然会把 glibc runtime 放进包内。

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
tar -xzf farming-2.tar.gz
cd farming-2
./farming
```

低 glibc Linux 上也使用同样命令。脚本默认 `FARMING_USE_GLIBC=auto`，检测到系统 glibc 低于 2.28 时，会优先使用包内 `vendor/glibc228-lib.tar.gz` 安装私有 glibc 2.28 runtime。

如果目标机已有私有 glibc 2.28 runtime：

```bash
tar -xzf farming-2.tar.gz
cd farming-2
FARMING_USE_GLIBC=auto FARMING_GLIBC_ROOT=/opt/farming/glibc228 ./farming
```

如果解压目录同级已经有 `glibc228/lib/ld-2.28.so`，脚本会自动优先复用：

```text
/deploy/farming-2/
/deploy/glibc228/lib/ld-2.28.so
```

这种情况下直接运行：

```bash
cd /deploy/farming-2
./farming
```

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

主要用户配置项：

- `defaultLaunchAgent`：New Agent 默认 provider，目前是 `codex` 或 `claude`；
- `agentLaunchProfiles.codex`：Codex 的权限、模型、reasoning、service tier profile；
- `agentLaunchProfiles.claude`：Claude 的 permission、model、effort profile；
- `workspaceHistory`：New Agent 启动时使用的最近 workspace；
- `mainPageSessionKeys`：Farming 保留在主页面的真实 provider session key；Codex `tmp_uuid...` live id 不会写入这里，不在这里的 session 只出现在 History；
- `dangerouslySkipAgentPermissionsByDefault`：是否默认启用支持 agent 的激进权限绕过模式。

Native terminal session 由 Farming pty host 托管，通过从 `configDir` 派生的本地 socket 连接。默认保留 host 以支持 server 重启恢复；最后一个 live session 和 client 都消失后，host 会在短暂空闲宽限期后自退出。后续 terminal runtime 工作应面向 native pty host 和 xterm.js 链路。

应用内升级默认关闭。只有设置 `FARMING_UPDATE_MANIFEST_URL` 指向 HTTP(S) JSON manifest 后，Farming 才会检查和下载升级包：

```json
{
  "version": "2.0.7",
  "tarUrl": "farming-2.0.7.tar.gz",
  "bundledGlibc": true,
  "sha256": "<optional-sha256>"
}
```

相对 `tarUrl` 会按 manifest URL 解析；如果 tarball 放在另一个目录，可以设置 `FARMING_UPDATE_ASSET_BASE_URL`。未配置时不会请求 GitHub release，用户应手动升级。

部署配置模板位于 `config/`：

- `config/farming.deploy.env.example`
- `config/farming.install.env.example`

真实 `.env` 配置文件会被 git 忽略。

## 安全

Farming 可以控制目标机器上的真实 terminal 和 agent 进程，适合运行在可信开发机和可信网络中。不要在没有 VPN、SSH tunnel、HTTPS 反向代理或网络 ACL 等额外安全层的情况下直接暴露到公网。

启动 token 会同时保护 HTTP 页面和 WebSocket 连接。它在首次鉴权启动时随机生成，持久保存到 `~/.farming/.session-token`，并在后续重启和升级中复用。生成的新 token 刻意做成比长十六进制串更容易复制的可读口令：中文时区默认生成中文俳句式口令，日本时区默认生成日文俳句式口令，其它时区默认生成英文短语；也可以用 `FARMING_TOKEN_LOCALE=zh|ja|en|auto` 显式指定新 token 的生成语言。

`FARMING_DISABLE_AUTH=1` 只应该用于可信本地开发环境。Codex / Claude Code 的具体执行权限仍然由对应 CLI 和 profile 决定。

安全上报和部署注意事项见 [SECURITY.md](./SECURITY.md)。

## 排错

- **Codex 或 Claude Code 无法启动**：先确认同一台机器上对应 CLI 已安装、已登录，并能在普通 shell 中直接运行。
- **Native PTY 无法启动**：检查打包的 `node-pty` runtime 能否在目标机加载；老 glibc 机器优先使用 `farming-2.tar.gz` app bundle，而不是单文件 binary。
- **端口占用**：可以传 `--port <port>`；如果没有显式指定端口，默认 daemon 启动会自动上探选择可用端口。
- **手机访问不了**：使用启动日志里打印的 Network URL，并确认手机能访问目标开发机。
- **找不到 token URL**：运行 `./farming url`，或查看 `./farming logs`。

## 目录结构

```text
farming/
├── .gitattributes          # 源码归档 export-ignore 规则
├── backend/                 # Node.js server、session engine、agent manager、session/history/usage/file/slash-command APIs
├── src/                     # React + Vite 前端；Farming Code 皮肤与交互 helper 位于 src/components/code/
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
