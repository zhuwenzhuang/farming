# Provider 与权限

Farming 连接不同的 Coding Agent。Provider 继续负责自己的登录、模型和 Session 能力，Farming 则提供一致的 Project、Chat、Terminal 和 Files 使用方式。

## 支持的交互

当前常用 Provider 包括 Codex、Claude Code、OpenCode、Qoder、Qwen Code、Pi 和其他能够被 Farming 发现的 Coding CLI。

Pi Chat 使用 Release 固定的 `pi-acp` Adapter 和已安装的 Pi Executable。Pi 当前要求
0.80.4 或更高版本以及 Node.js 22.19 或更高版本。Farming 会在启动 Chat 前验证 Pi 产品身份与
版本。该 Adapter 尚不转发 ACP MCP Server，也不委托 Client Filesystem
与 Terminal Operation，因此 Farming 只展示 Live Handshake 实际返回的 Capability。

不同 Provider 可能支持：

- 结构化 Chat；
- 原生 Terminal；
- 历史 Session 恢复；
- 模型和推理强度选择；
- 运行中的 Chat / Terminal 切换。

Farming 只展示当前 Provider 真实声明并通过运行时检查的能力。

## 登录

Provider 登录发生在 Farming Host 上。安装 Farming 不会自动登录 Coding Agent。

排查登录问题时：

1. 在 Host 的普通 Shell 中启动对应 CLI；
2. 完成登录或修复 Provider 配置；
3. 返回 Farming，重新检查能力或启动 Agent。

不要把 Provider Token 写进 Project 文件或公开的 Farming 配置示例。

## 权限原则

权限越高，Agent 可以连续完成的操作越多，同时潜在影响范围也越大。

- 对不熟悉的仓库使用需要确认的策略。
- 只允许 Agent 访问完成任务所需的 Workspace。
- 涉及账号、发布、支付、消息发送或数据删除时保留人工确认。
- Browser 与实验性 Computer 的账号和系统权限是独立安全边界。

## 权限变化

改变权限不会更换当前 Agent 或 Workspace，也不会自动创建新的 Browser Profile，或把资源交给另一个 Agent。

遇到权限请求结果不明确时，先检查当前页面、文件和 Git 状态，不要立即重复执行原操作。
