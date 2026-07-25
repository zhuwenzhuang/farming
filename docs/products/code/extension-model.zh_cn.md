# Farming Code 扩展模型

> English version: [extension-model.md](./extension-model.md)

状态：产品方向，尚不是已经实现的公开 Extension API。

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

Farming 启动或恢复 Agent 时，在 Session 边界把该 Agent 已启用的 Extension Capability 交给 Provider Adapter 投影。具体 Transport 可以因 Provider 而异，但 Tool Identity、Schema、Ownership、Permission Policy 和 Result Semantics 仍由 Farming Extension Contract 定义。

预期关系是：

```text
Extension Runtime 与 Viewer
          |
          | Farming Extension Contract
          v
Farming Resource UI + Agent Capability Registry
          |
          | Provider Adapter Projection
          v
Codex / Claude / OpenCode / Qoder
```

Agent 仍然可以保留 Provider 原生或用户自行安装的工具。Farming 不会静默替换这些工具。Tool Ownership 和名称冲突必须显式处理，当前 Agent 也应能发现哪些 Capability 来自 Farming、哪些来自 Provider 自身。

## Browser Extension 示例

Browser Extension 可以拥有 Browser Session、Profile 和 Automation Endpoint。Extension Viewer 展示这个精确 Session，Extension 提供的 Agent Tools 也操作同一个身份。这样用户可以观察或接管浏览器，而不需要在每一种 Agent 实现中加入 Provider 特有的浏览器代码。

Browser Extension 内部可以使用 CDP、Playwright、原生 WebView、远端画面流或其他实现。这些选择应留在 Extension 边界之后。Farming Core 只需要理解通用的 Resource Identity、Viewer Lifecycle、Capability Inventory、Authorization 和 Agent Association。

对于远端 Linux Browser，第一版可以组合 Chromium、虚拟显示和浏览器可访问的 Observer Surface，并通过 CDP 或 Playwright 提供自动化。但这属于 Extension 的实现细节，不应成为 Farming Core 中另一条永久浏览器分支。

## 待确定问题

第一版实现必须解决以下问题，之后才能把 Extension API 视为稳定 Contract：

- Agent Tools 主要通过 MCP、ACP/client-tool Extension，还是 Farming 自己的 Tool Bridge 投影；
- 实时 Resource 默认归属于 Agent、Project，还是显式共享的 Workspace Scope；
- 如何展示 Tool 名称冲突和 Provider 原生等价能力；
- Extension UI 在 Farming 页面内如何隔离和授权；
- Farming Core 对实时 Extension Runtime 要求哪些生命周期与恢复保证。

当前已经明确的架构约束是：Resource 展示和 Agent Tools 属于同一个 Extension；Provider 特有的翻译继续留在现有 Provider Adapter 边界。
