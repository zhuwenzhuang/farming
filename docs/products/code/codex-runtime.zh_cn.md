# Codex Runtime 模式

> English version: [codex-runtime.md](./codex-runtime.md)

Farming 对用户提供两种 Codex Surface：

- **Chat** 使用受支持的 ACP Runtime。
- **Terminal** 在 Farming Native PTY Host 中运行 Codex CLI。

用户选择的是 Chat 或 Terminal，不是私有 Transport 实现。旧 History Format 可以继续只读，
但不能成为 Live Runtime Path。

## Executable 所有权

Terminal 与 ACP 是相互独立的 Executable Ownership Boundary：

- Terminal 优先使用可用的系统 Codex，并只按 Native Terminal 版本策略选择经过校验的
  Farming 自有 Executable。
- ACP 独立使用 Farming 自有、版本锁定的 Adapter 与 Runtime Artifact，不继承 Terminal 选择。

新建 ACP Chat Session 按精确 Codex Agent Home 使用版本锁定的 Managed Executable；
Plugins 不提供 Custom Executable 选择。Terminal Discovery 继续独立，已有 Session 保留
持久化 Launch Identity，包括精确恢复所需的旧 Custom Binding。

这两个策略分离后，Native CLI 体验和确定性的 ACP 行为可以独立演进，不会互相静默改变。

## Provider Adapter 边界

通用 Chat Lifecycle、Transcript、Config、Permission 与 Recovery 归共享 ACP Runtime；Codex
Adapter 只拥有 Codex 特有的 Launch、Executable、Capability 与可选 Extension 行为。

Capability 以 Live ACP Handshake 和 Session State 为准。Live Steer 等 Codex Extension 必须
带版本且经过协商；UI 不能只因为 Agent 名称是 Codex 就启用。

Codex 的 Media、Tool、Diff、Terminal、Permission、Config 与 Child Activity 都保持为类型化
Protocol Data。Provider 特有展示 Hint 在 Adapter 边界归一化，不能变成通用 ACP 语法。

Native Terminal 的启动排序不是一套 Codex Lifecycle State Machine。共享的 Terminal
Startup Coordinator 拥有有界串行、就绪、失败与清理；Codex Adapter 只声明无状态约束：
共享同一精确 Agent Home 的 Native Start 必须串行到 TUI 发出就绪信号，因为这些进程共享
该 Home 的本地 Store。其他 Provider 继续并发，除非其 Adapter 声明等价的资源约束。

Provider Terminal Control 还负责 Codex 的延迟 Session Identity Probe，以及 Native Model、
Reasoning 与 Speed Transaction。通用 Agent Manager 负责有序 Input、Runtime Fence 与 State
Publication，但不识别 Codex，也不解释其 Menu。

## Session 连续性

Provider Session ID 是 Codex Conversation 的权威身份。Chat/Terminal 切换是真实 Runtime
Replacement，只有在证明可恢复时才保留该身份。

全新 Terminal 可以在用户输入物化 Provider Conversation 前切换；一旦收到输入，切换、权限
重启、恢复与 Fork 都需要已验证的可恢复身份。Terminal Presentation 不得从任意 Output Text
推断该身份。

因此，全新 Codex Terminal 先使用仅属于 Farming 的 Temporary Identity，而不是猜测 Resume
ID。精确 Runtime 进入 Idle 后，Codex Terminal Control 通过有序 Input Path 执行一次有界
`/status` Probe，且不把它标记为用户输入。写入结果不确定时只从渲染出的 Status 对账，绝不
重放。只有结构化 Status Panel 可以确认真实 Session ID，并且确认受同一 Agent 与 Runtime
Epoch Fence 保护。在确认成功前，History Lookup、Recovery 与 Fork 都继续把该身份视为
Temporary。

配置遵循共享 ACP 规则：用户没有确认显式 Override 前，使用 Provider 与 Agent Home 默认值；
已确认的 Model、Reasoning、Speed 与 Permission Choice 在受支持的 Runtime Replacement 后保留。
保存的选项不再可用时，优雅降级到 Provider 当前值，并显示可见警告。

Codex Chat 声明支持 Active-Turn Conversation Fork。版本锁定的 Adapter 捕获当前 Codex Turn
ID，并把它作为 app-server 的 `beforeTurnId` Boundary 发送；因此 Child 排除尚未完成的 Turn，
同时 Source 继续运行。在 Codex 尚未分配该 Turn ID 的短暂窗口内，Fork 仍不可用。

## 失败与恢复

Adapter 或 PTY 失败必须可见。Farming 可以在证明旧 Runtime Ownership 后恢复同一 Provider
Session，但绝不重放结果不明确的 Prompt 或 Terminal Mutation。Chat/Terminal 切换失败时，
应尽量恢复原 Runtime，并明确报告失败。

## 验收标准

验证必须覆盖：Executable Policy 分离、协商 Capability、Provider Identity、同 Home Native
Start 串行、不同 Home 并发、Config 连续性、Chat/Terminal 切换、Restart、Disconnect、
Media 与 Tool 展示、声明支持时的 Live Steer，以及受支持 ACP 与 Native Terminal Path 的
低频真实 Codex Smoke。
