<p align="center">
  <img src="./public/farming-2/app-icon-v2-512.png" alt="Farming Code" width="112">
</p>

<h1 align="center">Farming Code</h1>

<p align="center">
  Farming Code 是一个开源、自托管的浏览器工作区，用于启动和管理 Codex、Claude Code、OpenCode 及其他 AI Coding Agent。
</p>

<p align="center">
  <a href="https://zhuwenzhuang.github.io/farming/cn/">在线文档</a> ·
  <a href="./README.md">English</a>
</p>

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

准备好 Node.js 22.13 LTS（22.x）或 Node.js 24+，并确保至少有一个可用的
Coding Agent Provider：

```bash
npm install --global farming-code@latest && farming daemon
```

打开命令输出的任意一个带鉴权 URL，选择 **New Agent**，然后启动任务。完整首次使用流程见[快速开始](./docs/getting-started.zh_cn.md)。

![启动 Agent](./docs/products/code/assets/02-start-agent-picker.png)

## Farming Code

Farming Code 是默认的桌面与手机界面。它按项目组织工作，把实时 Agent、可恢复的 History、文件、浏览器和 Review 放在同一个浏览器工作区里。

### Agent、Chat 与 Terminal

启动或恢复 Codex、Claude Code、OpenCode、Qoder、Qwen Code 以及其他检测到的 Coding Agent。使用结构化 Chat 阅读结果和检查过程，或使用 Terminal 直接操作 CLI。

![Farming Code 结构化 Agent 过程](./docs/products/code/assets/11-code-agent-process.png)

### Files 与 Review

浏览、搜索并轻量编辑 Project Files，不需要离开当前任务。需要证据时可以检查修改并打开 Review。

### Browser Resource

Farming 让人和 Agent 使用同一个 Project Browser。详见 [Farming Browser](docs/products/code/browser-agent-cli.zh_cn.md)。

## 支持的 Agent

| Agent | 结构化 Chat | Terminal | History / Resume |
| --- | --- | --- | --- |
| Codex | 是 | 是 | 是 |
| Claude Code | 是 | 是 | 是 |
| OpenCode | 是 | 是 | 是 |
| Qoder | 是 | 是 | 是 |
| Qwen Code | 是 | 是 | 是 |
| bash / zsh | — | 是 | 否 |

使用 Provider 的 Agent 仍需要有效登录；其他被发现的 CLI 必须能在 Farming Host 上正常运行。

## 远程使用

在开发机上运行 Farming，再从能够访问这台机器的电脑或手机打开带鉴权 URL。浏览器断开后 Agent 仍会继续运行。远程访问和安全说明见[运行与维护](./docs/operations/README.zh_cn.md)。

## Farming CRT

Farming CRT 是可选的键盘优先复古控制室，用来扫视多个 Agent、打开它们的 Chat 或 Terminal、搜索 History，以及查看用量遥测。

![Farming CRT 多 Agent 仪表盘](./docs/products/crt/assets/01-crt-dashboard.png)

Code 与 CRT 使用相同的后端 Agent 和 Session，切换界面不会创建第二个 Agent。Farming Code 仍是默认界面，也是受支持的手机界面。控制方式和完整流程见 [Farming CRT 指南](./docs/products/crt/README.zh_cn.md)。

## 安装与更新

按上面的快速开始命令安装即可。npm 安装可以从 **Settings → Updates** 更新。

![Farming npm 更新设置](./docs/products/code/assets/14-code-settings.png)

独立 CLI 和目录 Bundle 仍可从 [GitHub Releases](https://github.com/zhuwenzhuang/farming/releases) 手动下载安装。应用内更新不会读取 GitHub Releases，只对 npm 安装开放。

## 安全

Farming 会控制开发机上的真实终端和文件。请只运行在可信主机和可信网络中，不要在没有 VPN、SSH Tunnel、HTTPS Reverse Proxy 或等价访问控制时直接暴露到公网。

部署与报告说明见 [SECURITY.zh_cn.md](./SECURITY.zh_cn.md)。

## 文档

- [在线中文文档](https://zhuwenzhuang.github.io/farming/cn/)
- [仓库架构与开发文档](./docs/README.zh_cn.md)
- [版本历史](https://github.com/zhuwenzhuang/farming/releases)
- [参与贡献](./CONTRIBUTING.zh_cn.md)

## License

Farming 使用 [MIT License](./LICENSE)。第三方组件声明见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。
