# Agent 清理与 History

> English version: [agent-cleanup-history.md](./agent-cleanup-history.md)

History 记录已经结束的 Agent Lifecycle，不是第二套 Live Session Owner。

Agent Lifecycle Owner 决定 Agent 是否存活并执行精确 Termination；History Store 拥有 Archive
Summary；Browser 只展示这些权威结果。

非 Main Agent 可以因用户主动终止、保守的 Inactivity Policy 或 Process Natural Exit 离开 Live
Supervision。只有 Runtime 到达终态后，Farming 才从 Live List 移除 Agent，并记录一份包含用户
关心的 Identity、Workspace、Timing 与 End Reason 的 Archive Summary。

Main Agent 永远不能被自动清理。时间久不能证明 Runtime 已停止。对同一 Terminal Lifecycle
的重复观测不能产生互相冲突的 Archive Result。

无法证明 Termination 时，Agent 保持可见并展示可重试失败。Termination 成功但 History
Persistence 失败时，Farming 单独报告 Archive Failure，不能声称已经记录 History。

验证必须覆盖 Manual Termination、Inactivity Selection、Natural Exit、Main Agent Exclusion、
Duplicate Terminal Observation、Persistence Failure 与 Restart Reconciliation。
