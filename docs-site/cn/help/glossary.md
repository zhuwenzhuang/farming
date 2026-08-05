# 术语表

Farming 保留了一些产品和开发工具中的英文名称，以便与界面、CLI 和 Provider 文档保持一致。

## Agent

执行编码任务的 Coding Agent 或 Shell Session。每个 Agent 都有精确身份、状态和 Workspace 边界。

## Project

Farming 中围绕一个代码仓库组织的工作分组。Project 帮助用户把 Agent、Files 和资源放进正确上下文。

## Workspace

Agent 获准访问的实际工作目录。文件读取、Browser 上传下载和部分资源操作都受这个路径边界约束。

## Host

运行 Farming 后端、Coding CLI、Agent 进程和项目文件的开发机。浏览器只是连接到 Host 的界面。

## Provider

提供 Coding Agent 的运行时或 CLI，例如 Codex、Claude Code 或 OpenCode。Provider 负责自己的登录、模型和 Session 能力。

## Session

一次可持续或可恢复的 Agent 交互。关闭浏览器不等于 Session 已经结束；是否能恢复取决于 Provider 和 Session 类型。

## Resource

归属于某个 Agent 和 Project 的外部能力实例，例如 Browser，或实验性的 Computer。Resource 有自己的生命周期和隔离边界。

## Owner

某个状态或 Resource 的权威拥有者。Farming 在停止、删除和恢复前会核对精确 Owner，避免影响另一个 Agent 或配置实例。

## Snapshot

Browser 在某一时刻的结构化页面观察结果。页面变化后，旧 Snapshot 中的元素引用可能失效。

## PTY

伪终端（Pseudo Terminal）。Farming Terminal 通过 PTY 连接真实 Shell 和 Coding CLI，保留交互式输入、尺寸和终端输出。
