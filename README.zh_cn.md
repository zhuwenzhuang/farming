<p align="center">
  <img src="./public/farming-2/app-icon-v2-512.png" alt="Farming Code" width="112">
</p>

<h1 align="center">Farming Code</h1>

<p align="center">
  Farming Code 是一个开源、自托管的浏览器工作区，用于启动和管理 Codex、Claude Code、OpenCode 及其他 AI Coding Agent。
</p>

<p align="center"><a href="./README.md">English</a></p>

<p align="center">
  <a href="https://github.com/zhuwenzhuang/farming/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/zhuwenzhuang/farming/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://github.com/zhuwenzhuang/farming/releases"><img alt="Release" src="https://img.shields.io/github/v/release/zhuwenzhuang/farming?label=release"></a>
  <a href="https://www.npmjs.com/package/farming-code"><img alt="npm" src="https://img.shields.io/npm/v/farming-code?label=npm"></a>
  <a href="./LICENSE"><img alt="License" src="https://img.shields.io/github/license/zhuwenzhuang/farming"></a>
  <img alt="Node.js 22.13 LTS or 24+" src="https://img.shields.io/badge/node-22.13_LTS_%7C_24%2B-339933?logo=nodedotjs&amp;logoColor=white">
  <img alt="macOS and Linux" src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux-555">
</p>

![Farming Code 工作台](./docs/products/code/assets/01-code-workspace.png)

Farming Code 与代码仓库和 Coding CLI 运行在同一台开发机上。Agent 进程、终端和项目文件都留在这台机器上；电脑或手机浏览器连接并操作这些真实 Session。

## 快速开始

准备好 Node.js 22.13 LTS（22.x）或 Node.js 24+，以及至少一个已安装、已登录的受支持 Coding CLI：

```bash
npm install --global farming-code@latest && farming daemon
```

打开命令输出的任意一个带鉴权 URL，选择 **New Agent**，再选择 CLI、Workspace 和 Chat 或 Terminal。关闭浏览器不会停止 Agent；同一个浏览器可以再次打开该地址。在开发机上，下面的命令会重新输出本机地址：

```bash
farming url
```

新的远程浏览器应使用 `farming daemon` 启动时输出的带鉴权 **Network** URL。VPN、SSH Tunnel 或 HTTPS Reverse Proxy 可以提供稳定且可达的地址，但第一次访问仍需要 Farming 启动 Token。

![启动 Agent](./docs/products/code/assets/02-start-agent-picker.png)

## Farming Code

Farming Code 是默认的桌面与手机界面。它按项目组织工作，把实时 Agent、可恢复的 History、文件、浏览器和 Review 放在同一个浏览器工作区里。

### Agent、Chat 与 Terminal

启动或恢复 Codex、Claude Code、OpenCode、Qoder 以及其他检测到的 Coding CLI。受支持的 Agent 提供结构化 Chat，用来阅读结果和检查工具活动；也可以打开真实 Terminal，直接操作 CLI。Search 和 History 同时覆盖当前工作与可恢复 Session。

![Farming Code 结构化 Agent 过程](./docs/products/code/assets/11-code-agent-process.png)

### Files 与 Review

浏览、搜索并轻量编辑 Project Files，不需要离开当前任务。检查 Git Changes、History、Diff 和 Blame，再把 Commit 或 Working Copy 修改打开到 Review。

![Farming Code 项目文件与 Blame](./docs/products/code/assets/04-files-editor-blame.png)

### Browser Resource

每个 Project 可以拥有多个可命名的 Browser Resource。Farming 使用兼容的 Chromium 系系统浏览器和独立 Profile 启动浏览器，把这个 Headless 页面流式展示在工作区中，并把人的输入和 Agent 操作发送给同一个 CDP Session。Farming 不下载 Chromium，也不依赖 Playwright。Agent 可以通过 `farming browser` 发现并操作这些 Resource；npm 安装还会提供 `farming-browser` 别名。

Farming 也可以连接由管理员独立管理的 Chromium CDP Endpoint，包括 Docker 中暴露的 Chromium；配置方式见[外部 CDP 浏览器指南](./docs/products/code/external-cdp-browser.zh_cn.md)。

第一版 Browser Viewer 面向网页展示与简单 Agent 操作，不替代浏览器完整窗口、DevTools、下载界面、浏览器扩展或 Computer Use。

## 支持的 Agent

Farming 会发现开发机上已经安装的 CLI。Codex、Claude Code、OpenCode 和 Qoder 同时支持结构化 Chat 与原生 Terminal；其他检测到的 Coding Agent 使用 Terminal 路径。

| Agent | 结构化 Chat | Terminal | History / Resume |
| --- | --- | --- | --- |
| Codex | 是 | 是 | 是 |
| Claude Code | 是 | 是 | 是 |
| OpenCode | 是 | 是 | 是 |
| Qoder | 是 | 是 | 是 |
| Qwen Code | — | 是 | 取决于 CLI |
| Aider | — | 是 | 取决于 CLI |
| GitHub Copilot CLI | — | 是 | 取决于 CLI |
| Amazon Q | — | 是 | 取决于 CLI |
| bash / zsh | — | 是 | 否 |

Farming 承载的是已经能在同一台机器正常工作的 CLI，不替代 Provider 的安装、登录和账户配置。

## 远程使用

在开发机上运行 Farming，再从能够访问这台机器的电脑或手机打开带鉴权 URL：

```text
电脑或手机浏览器
       │ HTTP / WebSocket
       ▼
开发机
  Farming Server
  ├── Coding Agent 进程
  ├── 真实 Terminal
  ├── 代码仓库与项目文件
  └── 可选的系统浏览器进程
```

浏览器断开或重新连接不会停止 Agent。Farming Server 正常重启后也可以重新连接受支持的实时 Terminal Session。桌面布局把项目、对话、文件和 Review 放在一起；手机布局一次聚焦一段对话、一个 Terminal 或一个文件。

<p align="center">
  <img src="./docs/products/code/assets/05-mobile-agent-chat.png" alt="使用手机重新连接仍在运行的 Farming Code Agent" width="390">
</p>

## Farming CRT

Farming CRT 是可选的键盘优先复古控制室，用来扫视多个 Agent、打开它们的 Chat 或 Terminal、搜索 History，以及查看用量遥测。

![Farming CRT 多 Agent 控制室](./docs/products/crt/assets/01-crt-dashboard.png)

Code 与 CRT 使用相同的后端 Agent 和 Session，切换界面不会创建第二个 Agent。Farming Code 仍是默认界面，也是受支持的手机界面。控制方式和完整流程见 [Farming CRT 指南](./docs/products/crt/README.zh_cn.md)。

## Farming Net

Farming Net 是独立、带 Token 鉴权的 Farming 部署目录。它提供一个入口打开已登记实例，但不保存目标 Token，也不代理目标流量。登记方式和安全边界见 [Farming Net 指南](./docs/products/net/README.zh_cn.md)。

## 安装与更新

安装后的 `farming` CLI 默认端口是 `6694`，Base Path 是 `/farming`，配置目录是 `~/.farming`，Token 鉴权默认开启。常用 Daemon 命令：

```bash
farming status
farming url
farming logs
farming stop
```

Farming Server 采用 crash-only 生命周期：`farming stop`、重启和升级都会立即终止 Server，不等待正在运行的 Agent 工作。下一个 Server 进程负责对账 Farming 自有状态并重新连接受支持的存活 Runtime；被中断的 Provider Turn 仍可能需要走 Provider 自己的正常 Resume。如果 Updater 没有权限停止记录中的 Server 进程，它会保持新旧包目录不变，并提示用户由拥有该进程的系统账号或管理员重启 Farming 后再重试。

启动 Token 存放在 `~/.farming/.session-token`，重启和升级会继续复用。**Settings → Updates** 为 npm 安装提供两阶段更新：点击**准备**后，所选版本会安装到独立 staging 目录，当前服务继续运行；准备完成后，只有用户点击**重启并应用**，Farming 才会切换包目录并重启。如果新服务启动失败，Farming 会恢复旧包目录。npm 准备阶段会先使用机器配置的 registry；只有该 registry 缺少所选版本时，才会回退到 Settings 展示版本所用的 registry。准备和应用更新前，Farming 都会校验 npm 目标包根目录与启动当前服务的包根目录一致。GitHub Releases 也提供独立 CLI 和目录 Bundle；当前产物见 [GitHub Releases](https://github.com/zhuwenzhuang/farming/releases)。

从源码运行，并使用相同的端口与 Base Path：

```bash
npm install
PORT=6694 FARMING_BASE_PATH=/farming npm start
```

只有在可信本地开发环境中，才可以用 `npm run start:no-auth` 关闭 Token 鉴权。

## 安全

Farming 会控制开发机上的真实终端和文件。请只运行在可信主机和可信网络中，不要在没有 VPN、SSH Tunnel、HTTPS Reverse Proxy 或等价访问控制时直接暴露到公网。

Token 鉴权同时保护 HTTP 和 WebSocket。`FARMING_DISABLE_AUTH=1` 只适合可信本地开发；Workspace 文件 API 会校验所有路径都位于所选项目根目录内。报告和部署说明见 [SECURITY.zh_cn.md](./SECURITY.zh_cn.md)。

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

只更新指定截图时，可以传入逗号分隔的文件名：

```bash
FARMING_SCREENSHOT_FILES=01-code-workspace.png npm run docs:product:screenshots
```

## License

Farming 使用 [MIT License](./LICENSE)。第三方组件声明见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。
