# Farming Code Extension Model

> English version: [extension-model.md](./extension-model.md)

状态：内部 Built-in Extension 架构，尚不是稳定的第三方 Extension API。

## 目标

Farming 应通过一套 Extension Model 增加 Live Resource、Viewer 与 Agent Capability，而不是
把每项能力分别硬编码到 Agent、Files 和 Sidebar 中。

一个 Extension 可以贡献：

- 具有稳定身份与生命周期的 Typed Resource；
- 一个或多个 Viewer 与上下文 Action；
- Backend Runtime 或 Connection Adapter；
- Agent-facing Tool 与 Capability Metadata；
- Installation、Permission、Health 与 Failure Information。

Built-in Extension 与未来外部 Extension 应使用同一套 Ownership Model。Distribution 与 Trust
可以不同，Integration Architecture 不应分叉。

## Resource 与 Viewer 边界

Farming Core 拥有 Workspace Composition、Tab、Sidebar Structure、Navigation、Authentication
与共享 Interaction Pattern。Extension 只拥有 Resource 特有 Lifecycle、Rendering、Status
Meaning 与 Action。

所有 Resource Row 组合 Core 统一拥有的 Geometry、Focus、Hover、Active、Action Reveal、
Keyboard 与 Empty State Contract。Extension-specific Style 只用于 Browser 或 Desktop Viewer
这类真正特有的 Surface。

Viewer Access 必须经过同一个已授权 Resource Identity。Preview 或 Streaming Path 不能形成
独立的 File、Browser 或 Desktop Authority。
打开 Agent 所拥有的 Resource Viewer 时，Sidebar 必须显示该 Agent 的 Resource Row，
并展开所选 Resource Section，使 Ownership 保持可见。

Current Plan、Browser Preview 等 Live Agent Activity 共享一个由 Core 拥有的右侧 Dock。
每项 Activity 始终保留可识别的紧凑 Header，但同一时刻最多只展开一个 Activity Body；
选择另一项时折叠前一项，而不是把两块 Surface 横向推到 Transcript 上。只有已展开的
Browser Preview 维持 Live Viewer Stream；折叠的 Preview 保留最后一帧，并在再次展开时
恢复连接。
Agent 详情 Preview 使用紧凑图标按类型汇总其拥有的 Resource 数量，让用户无需展开各个
Resource Section 也能判断资源使用规模。

## Ownership 与生命周期

每个 Live Resource 都有一个稳定 ID、一个精确 Owner 与一个 Authorization Scope。具体状态与
破坏性操作由所属 Extension 定义，但 Farming Core 要求：

- Mutation 或 Cleanup 前证明精确 Identity；
- 用 Generation Fence 拒绝过期异步结果；
- Startup、Stop、Reconnect 与 Failure 有界；
- 明确处理结果不确定的 Mutation；
- 重启后根据权威持久化状态对账；
- 只删除 Owner 能精确证明归属的 Resource 与 External Object。

Agent-owned Resource 可以跨 Chat/Terminal Replacement 保留。停止或归档 Agent 时，其
Browser Resource 会按精确 ID 删除，避免临时 Browser Row 与 Profile 累积；其他 Resource
类型继续遵循所属 Extension 定义的生命周期。删除 Agent 只删除它精确拥有的 Resource。

对于 Browser Resource，`stop` 保留 Row 与持久化 Profile 以便后续复用；`delete` 会先停止
Runtime，再同时删除 Row 与 Profile。面向 Agent 的 CLI 必须同时暴露这两个操作，使临时验证
Resource 能按精确 ID 删除，而不是长期累积为 Stopped Inventory。Agent 生命周期中的停止或
归档使用删除；Chat/Terminal Replacement 明确不触发删除。

## Agent Capability 投影

Extension 通过一份 Farming-owned Capability Contract 发布 Agent Tool，不应分别实现 Codex、
Claude Code、OpenCode、Qoder 与 Qwen 的通用接入。

所有受支持且能执行命令的 Agent 都通过实例精确的 Farming CLI 发现同一 Capability。实时
可用性来自当前 Backend State，不能写死在 Prompt 中。Tool Identity、Schema、Ownership、
Permission 与 Result Semantics 继续由 Extension Contract 定义。

用户安装或 Provider-native Tool 可以共存。Ownership 与名称冲突必须显式处理；Farming 不会
静默替换其它 Tool。

## Plugins 与 Agent Home

Plugins Surface 展示 Built-in Capability、Agent Home Configuration 与 Extension Catalog。
打开页面是一条 Current-state Boundary：Capability 与 Catalog 都执行 Fresh Authoritative Read，
并保留可见 Loading 与 Failure。

Provider 加 Agent Home ID 是一份 Configuration Identity。Global Settings 拥有可接收新 Agent
的 Home 与展示顺序；Existing Agent Record 保留创建 Session 时使用的精确 Provider Home
不可变绑定，移除或重排配置不能给已有 Session 改身份。

同一 Identity 也拥有 ACP Runtime Selection。Plugins 在支持时展示 Adapter 的 Managed
Default 与显式 Custom Provider Executable。保存时校验精确 Executable Boundary。选择只
作用于新建 Chat Session；已有 Session 保留持久化 Launch Identity，Terminal Executable
Discovery 继续独立。

Extension Catalog 只属于一份精确 Home。Provider-owned Configuration 是 Enabled/Configured
状态与默认值的权威来源；Farming 不建立平行 Enablement Database，也不把多个 Home 合并成
一个 Provider-wide Identity。

## Browser 与 Computer

Browser 和 Computer 是同一 Resource Contract 上的 Built-in Extension：

- Browser 拥有结构化网页操作与共享 Page Viewer；
- Computer 拥有完整 Desktop 与控制权交接；
- Isolated Browser 可以租用 Agent-owned Desktop，但 Browser Tab 与 Desktop Lifecycle 保持独立。

Browser 与 Computer 可以安全共享轻量 Backend Capability Service，同时使用独立 CLI
携带的 Agent 名字，把 Resource Identity 与 Mutable Session State 路由到当前 Owner。该名字
是本地路由状态，不是额外权限 Credential。Farming 不注入或托管第二套 Browser/Computer
MCP 实现。

## Files 与 Language Server

File Viewer 体现同一模型：不同文件类型可以使用不同 Viewer，但共享一份 Project Authorization
与 Editor Workspace。Language Server 是组合 Project 与 Extension 边界的 Built-in Viewing
Capability，不引入第二套 Editor 或 Remote Execution Path。

## 安全与失败

Extension 在边界校验输入，展示当前 Availability，并在前置条件缺失时显式失败。未知或非
Active Agent 名字必须失败，不能回退到其他 Owner 的 Resource；Viewer Connection 仍绑定
精确 Resource。Transport Timeout 造成结果不确定时，必须先对账，再决定是否允许重试。

## 验收标准

验证必须覆盖：Resource Identity、Agent/Config 隔离、Authorization、Lifecycle Transition、
Restart、Reconnect、结果不确定、共享 Presentation、Fresh Capability Read、Agent Home Scope，
以及 Chat/Terminal 共用一套 CLI-backed Capability 实现。

第三方 API 稳定前，还必须定义 Package Trust、UI Isolation、Capability Name Collision 与
External Runtime 必须满足的最小 Lifecycle Guarantee。
