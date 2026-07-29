# 快速开始

> English version: [getting-started.md](./getting-started.md)

本文从安装开始，带你启动第一个 Agent。

## 环境要求

- macOS 或 Linux
- Node.js 22.13 LTS（22.x）或 Node.js 24+
- 至少一个可用的 Coding Agent Provider

Provider 仍需要登录。如果使用 Farming 在本机发现的 CLI，请先确认它能在 Farming Host 上独立启动。

## 安装并启动

```bash
npm install --global farming-code@latest
farming daemon
```

打开 `farming daemon` 输出的任意一个带鉴权 URL。

## 启动第一个 Agent

1. 选择 **New Agent**。
2. 选择 Agent、Workspace，以及 Chat 或 Terminal。
3. 发送任务。

关闭浏览器不会停止 Agent。在同一个已登录浏览器中，可在 Host 上运行 `farming url`
重新输出本机地址；要在新浏览器中登录，请使用 `farming daemon` 启动输出中的鉴权 URL。

## 接下来

- [Farming Code 指南](products/code/README.zh_cn.md)
- [Farming Browser](products/code/browser-agent-cli.zh_cn.md)
- [Farming CRT 指南](products/crt/README.zh_cn.md)
- [远程使用与运行维护](operations/README.zh_cn.md)
