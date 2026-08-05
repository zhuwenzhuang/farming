# 常见问题

## Farming 是云服务吗？

不是。Farming 是开源、自托管的工作区。Agent 进程、Terminal 和 Project 文件运行在你的 Farming Host 上。

## 使用 Farming 还需要 Provider 账号吗？

需要。Codex、Claude Code、OpenCode 等 Provider 仍使用各自的登录和服务条款。Farming 不提供或绕过 Provider 账号。

## 关闭浏览器会停止 Agent 吗？

不会自动停止。Farming 后端和 Agent 仍在 Host 上运行。重新打开地址后可以继续查看。

## 可以从手机访问吗？

可以。手机适合查看状态、阅读 Chat 和发送简短跟进。复杂 Terminal 操作和大范围文件编辑更适合较大屏幕。

## 可以通过互联网直接暴露 Farming 吗？

不建议。请使用 VPN、SSH Tunnel、HTTPS Reverse Proxy 或等价访问控制。带鉴权 URL 必须按凭证保护。

## Chat 和 Terminal 有什么区别？

Chat 以结构化方式展示 Agent 过程和结果；Terminal 提供真实 PTY 与原生 CLI 交互。Provider 支持时可以在同一个 Agent 上切换。

## Farming Browser 会使用我的登录状态吗？

取决于你选择的 Browser Source 和 Profile。只应把某个 Project 确实需要的账号交给 Agent，不同 Agent 不会默认共享 Cookie 和 Storage。

## 为什么看不到 Computer Use 或 Language Server？

它们是实验性功能，只在运行环境满足真实前置条件时显示。缺少依赖或初始化失败时，Farming 会明确说明，而不是提供未经验证的替代实现。

## Farming 支持 Windows 吗？

当前公开支持 macOS 与 Linux。其他平台不应视为已经达到相同的安装、PTY、恢复和浏览器验证标准。

## 在哪里查看版本？

在 Farming 界面左下角或 **Settings → Updates** 查看当前版本。公开版本记录位于 [GitHub Releases](https://github.com/zhuwenzhuang/farming/releases)。
