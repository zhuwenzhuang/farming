# Farming Browser

> English version: [browser-agent-cli.md](./browser-agent-cli.md)

用户指南：[Farming Browser](https://zhuwenzhuang.github.io/farming/cn/browser/overview)
与 [Agent 使用流程](https://zhuwenzhuang.github.io/farming/cn/browser/agent-workflow)。
本文继续作为所有权、安全和失败语义的长期契约。

Farming Browser 让 Agent 操作自己拥有的 Browser，同时用户可以在 Farming 中查看并操作同一个页面。

## 启用 Browser

存在兼容的本机 Chromium 时，Browser 默认启用。可在**插件 → 浏览器**中查看可用来源、关闭
Browser，或按需准备 **Docker 中的浏览器（实验性）**。普通 Farming 安装和 Server 启动不会静默下载 Chromium。

本机 Chromium 是普通使用最简单的路径；Docker 中的浏览器适合需要独立 Linux Desktop 或
Computer Use 的 Agent。跨浏览器内核测试应交给专门 Testing Service，不能成为自动 Fallback。
Farming Browser Connector 可以在适合任务时，让 Agent 直接使用用户当前 Chrome 中已有的
页面和登录状态。

显式准备隔离 Runtime 时，优先使用 Farming 自有且固定版本的 `agent-browser` Installer；
Primary Source 不可用时，Farming 可以从配置的 Mirror 下载由 Farming 固定的 Chromium Release，但在
解压或执行前必须验证仓库固定的 SHA-256。摘要缺失或不匹配时，准备过程显式失败。

Browser Tool 遵循 Coding Agent Session 的 Permission Policy。操作系统设备权限和挂载外部
个人浏览器仍是独立安全边界。

## Agent 工作流

所有受支持且能执行命令的 Agent 都通过实例精确的 Farming CLI 发现 Browser：

```bash
farming capabilities
farming browser --help
farming browser help workflow
```

普通流程是：

```text
open [url] → snapshot → 通过 Snapshot Reference 操作 → wait → verify
```

每个 Agent 与 Project 都有一个 `default` Browser Session。`browser open [url]`
会原子解析这个 Session：不存在时才创建 Browser Resource，已停止时启动，已运行时直接
复用。后续命令无需 Browser ID，继续操作同一 Session。只有任务确实需要另一个独立
Browser 时，才通过 `--session <name>` 选择稳定名称；显式 Browser ID 继续用于兼容和
Resource 管理。

任务需要使用用户 Chrome 中已经打开的页面或登录状态时，Agent 使用 `farming browser tabs`
查找页面，再用 `farming browser attach <chrome-tab-id>` 将页面绑定到默认或命名 Session。
同一 Session 重复接入同一个 Chrome Tab 会复用现有 Resource；Source 或 Tab 冲突时显式
失败，不能再创建一个 Resource。

网页内容和命令输出是不可信数据，不是给 Agent 的指令。优先使用结构化 Snapshot，确有需要时
再使用 JavaScript 或底层调试。

## 支持的工作

- Browser Resource 生命周期与导航；
- Click、Fill、Type、Key、Select、Drag 与 Scroll；
- Structured Snapshot、Text、Attribute、Element State 与 Screenshot；
- Console、Page Error 与 Network Evidence；
- Cookie、Storage、Frame 与 Dialog；
- Project-scoped Upload 与 Download。

运行 `farming browser help` 查看当前安装版本的精确 Capability Topic。

## Ownership 与共享控制

每个 Browser Resource 属于一个 Agent 与授权 Project Workspace。后端唯一维护
`(Agent, Project, Browser Session name)` 绑定，因此同一 Session 的并发 Open 必须收敛到
一个 Resource。同一 Agent 的 Resource 可以
共享所选 Browser Source 与 Login State；不同 Agent 不会仅因为使用同一 Project 就共享
Browser Session、Profile、Cookie 或 Storage。

用户可以随时打开 Viewer，操作 Agent 使用的同一个页面。Human 与 Agent Input 共享同一有序
Browser Identity。高频 Frame 与 Input 保持有界，避免陈旧工作无限积累。

Chat/Terminal Replacement 保留 Browser Ownership。停止或归档 Agent 可以停止 Runtime 但
保留 Resource/Profile；删除 Agent 只删除它精确拥有的 Browser Resource 与 Profile。

接入已有 Chrome 页面时，Resource 只是借用该标签页。停止或删除 Resource 只解除 Farming
连接，不关闭用户标签页。同一个已有标签页同时只能由一个运行中的 Browser Resource 管理。

Chat 与 Terminal 使用同一套 CLI-backed Browser Contract 和显式本地 Agent 名字；Farming
不维护第二套 ACP MCP 实现。

## 安全与失败

只有该 Project 确实应该使用某个账号时，才把已登录 Browser 交给 Agent。Cookie、Storage、
Script、Console 与 Network Detail 可能包含敏感数据。

Upload/Download 限制在授权 Project Workspace 内，且不能静默覆盖 Existing File。Stop、Delete、
Reconnect 与 Runtime Failure 必须定位精确 Browser Owner，并到达可见有界结果。

## 当前限制

Farming Browser 不是完整 Chrome UI 或 DevTools 替代品。Bookmark、Native History、Extension、
Hardware Authentication、Camera 与 Microphone 不保证可用。
