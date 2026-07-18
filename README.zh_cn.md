# Farming

> English version: [README.md](./README.md)

[![CI](https://github.com/zhuwenzhuang/farming/actions/workflows/ci.yml/badge.svg)](https://github.com/zhuwenzhuang/farming/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/zhuwenzhuang/farming?label=release)](https://github.com/zhuwenzhuang/farming/releases)
[![npm](https://img.shields.io/npm/v/farming-code?label=npm)](https://www.npmjs.com/package/farming-code)
[![License](https://img.shields.io/github/license/zhuwenzhuang/farming)](./LICENSE)
![Node](https://img.shields.io/badge/node-%3E%3D22-339933?logo=nodedotjs&logoColor=white)
![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-555)

Farming 是一个开源、可自定义、运行在开发机上的浏览器 AI Coding Agent 工作台。它把多个实时 Agent、结构化对话、真实终端、项目文件、Review、历史记录和运行时控制放在一起，同时代码仓库和 Agent 进程仍然留在开发机上。

在 Coding CLI 已经能正常工作的开发机上运行 Farming，就可以从电脑或手机回到同一批任务。关闭浏览器不会停止 Agent；Farming Server 重启时，独立的原生 PTY Host 也可以保留正在运行的终端会话。

## 快速开始

准备好 Node.js 22 或更新版本，以及至少一个已安装、已登录的受支持 Coding CLI，然后用一行命令安装并启动 Farming：

```bash
npm install --global farming-code@latest && farming daemon
```

打开命令输出的带鉴权 URL，选择 **New Agent**、Agent 类型和 Workspace，然后从 Chat 或 Terminal 开始工作。

![Farming Code 工作台](./docs/products/code/assets/01-code-workspace.png)

## 两套界面，同一套运行时

Farming 2 在同一批 Agent 和 Session 上提供两套完整的浏览器界面。

### Farming Code

默认工作台，适合阅读对话、介入任务、编辑文件和检查工作区修改。

![Farming Code 结构化 Chat](./docs/products/code/assets/11-code-agent-process.png)

### Farming CRT

键盘优先的控制室，适合同时观察多个 Agent、打开结构化 Chat 或原生 Terminal、搜索历史和查看实时用量遥测。

![Farming CRT 控制台](./docs/products/crt/assets/01-crt-dashboard.png)

| | Farming Code | Farming CRT |
| --- | --- | --- |
| 更适合 | 长对话、文件、编辑、Diff、Review | 总览监控、键盘控制、终端操作、遥测 |
| 实时 Session | 结构化 Chat 与真实 PTY Terminal | 磷光风格 Chat 与真实 xterm Terminal |
| 导航方式 | 项目侧栏、Search、History、Files | 稳定 Agent 机位和键盘控制台 |
| 外观 | 浅色与深色 | CRT 效果、终端字号、可选 Dynamic Heat |
| 入口 | `/farming/code/` 或 `/farming/` | `/farming/crt/` |

切换界面不会重启或复制 Agent。如果 Farming Code 启动或渲染失败，有限范围的诊断层仍会保留后面的实时 CRT 界面，而不是把正在运行的 Session 一起遮掉。

不修改地址也可以直接切换：

- **Farming Code → CRT：**点击左下角齿轮，打开**界面**，再选择 **Farming CRT**。
- **Farming CRT → Code：**按 `S`（或点击 **[S] SETTINGS**），在 **UI Theme** 中选择 **Farming Code**。

条件允许时，Farming 会把当前聚焦的 Agent 一起带到另一套界面。两边继续使用同一个实时 Agent 和 Provider Session；这里只切换界面，不会重启会话。

完整能力矩阵和截图导览见 [Farming 2 产品总览](./docs/products/README.zh_cn.md)。两套界面的完整流程分别见 [Farming Code 指南](./docs/products/code/README.zh_cn.md) 和 [Farming CRT 指南](./docs/products/crt/README.zh_cn.md)。

## Farming Net：部署门户

Farming Net 是一套独立、带 Token 鉴权的 Farming 环境目录。卡片可以指向当前设备、远程开发机、内网地址或隧道中的 Farming；已登记的目标接受短时签名通行证，让用户只保留一个门户登录，不再分别记录每个部署地址和目标 Token。

```bash
FARMING_NET_PORT=6693 FARMING_NET_BASE_PATH=/farming-net npm run start:net
```

门户自己的 Token、签名身份和私有 `instances.json` 注册表放在 `~/.farming-net/`。它不代理目标流量，也不保存目标 Token；每个目标仍是独立 Farming 服务，并且主动决定是否信任门户。登记方式和安全边界见 [Farming Net 指南](./docs/products/net/README.zh_cn.md)。

## 现在可以做什么

- 按项目组织实时 Agent，置顶或重命名重点工作、查看未读状态、搜索实时与历史 Session，并归档或恢复任务。
- Codex、Claude Code、OpenCode 和 Qoder 使用结构化 ACP Chat。计划、推理、工具调用、权限请求、内嵌终端、子 Session、附件、排队追问和精确修改摘要都可以保留，但不会淹没最终答案。
- 在结构化 Chat 与真实 PTY Terminal 之间切换同一个 Provider Session。支持的 Codex 模型、思考强度、Fast、Ultra 和权限修改会作用到实时工作流；兼容 Terminal 会立即应用模型修改，并在接受下一条 Composer 消息前确认 CLI 的真实状态。
- 浏览、搜索并轻量编辑 Project Files，通过复用 VS Code 图算法的 Git History 查看提交树与变更文件，检查 Git Changes、Diff 和 Blame，再把 Commit 或 Working Copy 修改送入带 Revision、行内评论和 Reviewed 状态的 Review。
- 在 Provider 提供所需数据时查看 CPU/MEM、Token Rate、Context、Quota、Provider 用量，以及 CRT 的按日/实时 Token 遥测。
- 从电脑或手机继续同一个 Farming Code 任务，Agent 进程始终留在开发机上。

![Farming Code 项目文件与 Blame](./docs/products/code/assets/04-files-editor-blame.png)

![Files 中分开的已跟踪与未跟踪 Review 入口](./docs/products/code/assets/10-review-workflow.png)

## 支持的 Agent 路径

Farming 会发现开发机上已经安装的 CLI。有 ACP 支持的 Provider 使用更完整的结构化运行时，其他检测到的 Coding Agent 仍然可以作为一等 Terminal Session 使用。

| Agent | 结构化 Chat | 原生 Terminal | History / Resume |
| --- | --- | --- | --- |
| Codex | ACP | 是 | 是 |
| Claude Code | ACP | 是 | 是 |
| OpenCode | ACP | 是 | 是 |
| Qoder | ACP | 是 | 是 |
| Qwen Code | — | 是 | 取决于 CLI |
| Aider | — | 是 | 取决于 CLI |
| GitHub Copilot CLI | — | 是 | 取决于 CLI |
| Amazon Q | — | 是 | 取决于 CLI |
| bash / zsh | — | 是 | 没有 Provider Session Resume |

Farming 承载的是已经能在同一台机器正常工作的 CLI，不替代 Provider 的安装、登录和账户配置。

## 运行默认值与 Daemon 命令

默认端口是 `6694`，Base Path 是 `/farming`，配置目录是 `~/.farming`，Token 鉴权默认开启。启动日志会打印类似下面的 URL：

```text
http://development-host:6694/farming?token=<startup-token>
```

常用守护进程命令：

```bash
farming status
farming url
farming logs
farming stop
```

第一次带鉴权启动会把随机、可读的 Token 写入 `~/.farming/.session-token`；后续重启和升级都会复用，除非显式设置 `FARMING_TOKEN`。Token 默认根据时区使用中文、日文或英文。

![启动 Agent](./docs/products/code/assets/02-start-agent-picker.png)

## 桌面与手机

桌面端把项目、对话、文件和 Review 放在彼此靠近的位置。移动端一次聚焦一段对话、一个终端或一个文件，并把导航移入抽屉，更适合查看进度和发送短介入。

Farming CRT 当前只作为桌面界面使用。手机请使用 Farming Code；CRT 手机方案目前仍是概念设计，不属于已支持的产品能力。

## 安装与更新

npm 包是默认分发方式。**Settings → Updates** 可以原地升级 npm 安装：Farming 会在当前 Server 仍运行时安装新包，只在安装成功后重启；新 Server 无法启动时会尝试回退。

GitHub Releases 也提供独立 CLI 和目录 Bundle。旧版 Linux x64 可以用 `linux-x64-legacy-glibc228` 完成第一次安装，后续应用更新继续使用同一个私有 npm Prefix。受控环境还可以单独构建 glibc 2.17 ABI Bundle。当前产物和版本说明见 [GitHub Releases](https://github.com/zhuwenzhuang/farming/releases)。

从源码开发：

```bash
npm install
npm start
```

只有在可信本地开发环境中，才可以用 `npm run start:no-auth` 关闭 Token 鉴权。

## 工作原理

```text
Farming Code / Farming CRT
  React, Monaco, xterm.js, CRT browser skin
                 │ HTTP + WebSocket
                 ▼
Farming core
  auth, Agent manager, ACP, history, files, review, usage
                 │ native PTY host + session providers
                 ▼
Development host
  repositories, shells, Codex, Claude Code, OpenCode, Qoder, ...
```

后端负责生命周期、鉴权、Session 路由、Workspace 边界、History 和配置。交互式 Terminal 默认由独立的原生 PTY Host 持有，因此浏览器和 Server 可以重新连接，而不需要替换实际进程。xterm.js WebGL 是唯一受支持的产品 Terminal Renderer；Ghostty Web Adapter 只保留为显式调试路径，不作为运行时 Fallback。

运行时设置存放在 `~/.farming/settings.json`。Farming Session 元数据、项目成员索引、归档运行、主题设置、更新状态、日志和启动 Token 使用 `~/.farming/` 下彼此独立的文件。外部 Provider History 保持只读，但明确的 Codex archive / unarchive 生命周期操作除外。

## 安全

Farming 会控制目标机器上的真实终端和文件。请只运行在可信开发机和可信网络中，不要在没有 VPN、SSH Tunnel、HTTPS Reverse Proxy 或等价访问控制时直接暴露到公网。

Token 鉴权同时保护 HTTP 和 WebSocket。`FARMING_DISABLE_AUTH=1` 只适合可信本地开发；Workspace 文件 API 会校验所有路径都位于所选项目根目录内。报告和部署说明见 [SECURITY.md](./SECURITY.md)。

## 文档

- [Farming 2 产品总览与能力矩阵](./docs/products/README.zh_cn.md)
- [Farming Code 指南](./docs/products/code/README.zh_cn.md)
- [Farming CRT 指南](./docs/products/crt/README.zh_cn.md)
- [Farming Net 部署门户](./docs/products/net/README.zh_cn.md)
- [移动端指南](./docs/products/code/mobile-guide.zh_cn.md)
- [ACP 运行时](./docs/products/code/acp-runtime.zh_cn.md)
- [Review 基础](./docs/products/code/review-foundation.zh_cn.md)
- [版本历史](https://github.com/zhuwenzhuang/farming/releases)
- [贡献者说明](./AGENTS.zh_cn.md)

## 开发检查

```bash
npm test
npm run typecheck
npm run lint
FARMING_BASE_PATH=/farming npm run build
npm run test:e2e:playwright
```

产品截图由匿名 Demo Workspace 和真实浏览器流程生成：

```bash
npm run docs:product:screenshots
```

## License

Farming 使用 [MIT License](./LICENSE)。第三方组件声明见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。
