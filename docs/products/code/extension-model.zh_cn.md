# Farming Code 扩展模型

> English version: [extension-model.md](./extension-model.md)

状态：内部 Viewer 基础和基于系统浏览器的 Browser Resource MVP 已经实现，但尚不是公开的第三方 Extension API。

## 已实现的基础

Project Files 现在通过同一个内部 Viewer Registry 解析内置的 Markdown、SVG 和 HTML Viewer。这建立了第一条窄而明确的 Extension 边界，但没有引入 Package 安装、动态第三方代码或第二套 Editor Framework。

静态 HTML Viewer 复用现有文件 Tab 和 Source / Preview 交互。一个有界的内存 Preview Session 只授权所选 Project Root 下的资源，并通过 Farming 已有且受鉴权保护的 HTTP Service 提供文件，因此不会新增监听端口。浏览器在沙箱 iframe 中渲染当前未保存草稿，禁用 Script、Form 提交、嵌套 Frame 和主动网络 API，并且只通过同一 Preview Session 解析已授权的相对静态资源。点击相对 HTML 链接后仍留在同一个 Session 中，目标页面的 Workspace Root 相对资源也继续经过 Broker。关闭 Viewer 会删除 Session；过期时间与容量上限负责回收遗留 Session。

用户显式打开的已知 Project Root 之外的可读文件仍然只读。对于精确打开的外部 HTML，临时 Preview Session 只授权该 HTML 所在目录，以便加载相对资源；它不会把这个目录加入 Files 浏览、Search、编辑或 Git Scope。

基于系统浏览器的 Browser Extension 是第一种实时 Resource 实现，集成默认关闭；Agent Tool 和 MCP 挂载仍然按需进行。系统没有兼容的 Chromium 系浏览器时，Settings 明确提示所需浏览器类型，不展示开关，Project Browser 分组也保持隐藏。系统浏览器可用时，Settings 展示“系统浏览器”开关。只有“已启用且当前可用”时，Extension 才贡献 Browser UI，并接受 Browser API、EventSource、Viewer WebSocket、CLI 或 MCP 操作；因此只有启用 Extension 后才会建立实时事件订阅。关闭时必须先停止所有受管 Runtime；若无法证明清理完成，关闭失败且设置保持开启。

每个 Project 可以拥有多个身份稳定、可重命名的 Browser Row。每一行都有独立 Profile 和显式的 `stopped -> starting -> running -> stopping -> stopped` 生命周期；启动或运行失败进入 `failed`。同一个 Browser 身份上的操作串行执行，过期 Viewer Generation 会被拒绝；Farming 重启时，之前仍处于运行态的行会标记为失败，而不会猜测某个已经失去 Owner 的浏览器进程是否可以安全复用。每次持久化变更都会递增单调 Resource Revision，因此 HTTP、EventSource 与 Viewer 更新即使乱序到达，也不能让 UI 回退到旧状态。

Extension 会发现兼容的 Chromium 系系统浏览器可执行文件，以 Headless 模式启动，并通过 WebSocket 直接连接原生 CDP。Farming 不携带 Chromium，Extension 也没有 Playwright 或 Puppeteer Runtime 依赖。`Page.startScreencast` 为受鉴权保护的工作区 Viewer 提供画面；Viewer 的 Pointer、Wheel、Keyboard 与 Resize 消息通过同一个 CDP Target 返回。Agent 操作也使用同一 Target，通过 Accessibility Snapshot、稳定的 Snapshot Ref、Screenshot、Navigation 和 CDP Input 工作。

Farming 不会把 Browser MCP 自动挂到 ACP Session。Codex、Claude Code、OpenCode 和 Qoder 在进程或 Session 创建时会收到一段很短的 Farming 启动提示，但 Farming 不修改 Project 或 Provider 自己的 Instruction 文件。这段提示要求 Agent 先查询 `farming capabilities`，不能假设能力存在。Browser 可用时，Agent 可按需通过 `farming browser` 列出、创建、启动、连接并操作当前 Project 的 Browser Resource；`farming-browser` 继续作为 npm Bin 别名。`farming browser mcp` 只供调用方在 Session 边界显式配置 MCP，不是默认挂载。

Farming Code 后续应通过 Extension 扩展能力，而不是把每一种新资源和 Agent 能力直接加入核心产品。浏览器是当前最明确的例子，但不应因此在核心中形成一套一次性的浏览器子系统。

## Resource 与 Viewer 模型

Extension 可以贡献一种有类型的 Resource，以及用于展示该 Resource 的一个或多个 Viewer。Farming 负责外围的 Workspace、Tab 和布局行为；Extension 负责该 Resource 特有的渲染和生命周期语义。

Files 已经体现了这一基础思想：文本、Markdown、图片、PDF、Diff 等文件类型使用不同 Viewer，但仍处在同一个 Workspace 上下文中。浏览器可以沿用同一模型，把页面视为一种实时超文本 Resource。它的 Viewer 可以展示本地或远端页面，但 Farming 应把它当成另一种可打开 Surface，而不是把浏览器行为硬编码到 Agent 和文件 UI 的各个位置。

未来一个 Extension Package 可以贡献：

- Resource 类型和稳定 Resource 身份；
- Viewer、Command 和上下文操作；
- 实时 Resource 所需的后端 Runtime 或连接 Adapter；
- Agent Tools 及其使用指引；
- Capability、Permission 和 Health 元数据。

内置 Extension 和外部安装的 Extension 应使用同一份 Contract。内置只应影响分发方式和默认信任级别，不应产生第二套接入架构。

## Agent Capability 投影

Extension 应通过一份由 Farming 定义的 Capability Contract 发布 Agent Tools。Extension 不应分别实现 Codex、Claude、OpenCode 和 Qoder 接入。

Farming 启动或恢复 Agent 时，只通过 Provider Adapter 在进程或 Session 边界注入简短的 Farming 启动提示。实时可用性不写死在提示词中：`farming capabilities` 会报告 Browser 是 Disabled、Unavailable 还是 Available，并在可用时给出按需使用命令。这样每个 ACP Session 不必默认承担 MCP 启动、Schema Context 和稳定性成本。用户或 Agent 仍可在确实需要 Tool Schema 时显式添加标准的 `farming browser mcp` stdio Server。Tool Identity、Schema、Ownership、Permission Policy 和 Result Semantics 仍由 Farming Extension Contract 定义。

预期关系是：

```text
Extension Runtime 与 Viewer
          |
          | Farming Extension Contract
          v
Farming Resource UI + Agent Capability Registry
          |
          | 启动提示 + 按需 CLI 或显式 MCP
          v
Codex / Claude / OpenCode / Qoder
```

Agent 仍然可以保留 Provider 原生或用户自行安装的工具。Farming 不会静默替换这些工具。Tool Ownership 和名称冲突必须显式处理，当前 Agent 也应能发现哪些 Capability 来自 Farming、哪些来自 Provider 自身。

## Browser Extension 示例

Farming 的 Browser Extension 启动系统已安装的浏览器，并拥有 Browser Session、Profile 和 CDP Endpoint。Extension Viewer 展示这个精确 Session，Extension 提供的 Agent Tools 也操作同一个身份。这样用户可以观察或接管浏览器，而不需要在每一种 Agent 实现中加入 Provider 特有的浏览器代码。

MVP 有意只支持一条实现路径：系统 Chromium 系浏览器、原生 CDP 与 CDP Screencast。它不暴露浏览器原生窗口框架、Extension、下载界面、DevTools、任意桌面交互或 Computer Use。这些属于独立产品能力，不是隐藏的 Fallback Path。

每个 Browser 都有持久唯一 ID，归属于一个 Project Workspace，并可通过 `browser` URL Query Parameter 直接打开。Browser Metadata 与 Profile 位于 Farming 配置目录下；删除 Browser Row 时必须先停止它的精确 Runtime，再删除独立 Profile。

## 待确定问题

第一版实现必须解决以下问题，之后才能把 Extension API 视为稳定 Contract：

- 后续实时 Resource 类型是否也默认归属于 Project，还是需要 Agent Scope 与显式共享 Scope；
- 如何展示 Tool 名称冲突和 Provider 原生等价能力；
- Extension UI 在 Farming 页面内如何隔离和授权；
- Farming Core 对实时 Extension Runtime 要求哪些生命周期与恢复保证。

当前已经明确的架构约束是：Resource 展示和 Agent Tools 属于同一个 Extension；Provider 特有的翻译继续留在现有 Provider Adapter 边界。
