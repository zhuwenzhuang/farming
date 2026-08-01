# Agent 清理与历史归档

> English version: [zombie-history-implementation.md](./zombie-history-implementation.md)

本文档定义长期不活跃或已经退出的非 Main Agent 的稳定清理与归档模型。History 是已结束 Agent 生命周期的记录，不是另一套 live Session owner。

## 用户故事

Farming 应避免被遗忘的 Agent 无限占用资源，同时保留足够上下文，让用户知道哪个 Agent 因为什么结束。清理体验应保持低干扰：归档运行进入 History，而不是增加一个常驻 Zombies 区域。

## 状态权威与转换

Agent 生命周期 owner 决定 Agent 是否存活并执行终止；持久化 History 存储拥有归档摘要；浏览器只展示这些权威结果。

符合条件的非 Main Agent 在用户主动终止或不活跃策略选中时，从 live 进入 terminating。进程自然退出不需要终止请求，但进入同一归档路径。Runtime 到达终态后，Farming 将 Agent 从 live supervision 中移除，并尝试记录一份归档摘要。

不活跃策略有意保持保守：它只使用持久化活动证据，并排除 Main Agent。阈值与扫描频率属于运行参数，不是归档数据契约。

## 正确性与恢复

安全性要求：Main Agent 永远不能被自动清理选中；归档摘要不能再被当作 live Process handle；对同一终态生命周期的重复观测不能产生互相冲突的归档结果。

活性要求：每个已经受理的清理必须到达可见终态——停止、确认已经退出，或明确失败且 live Agent 仍保留以便重试。重启后可以根据持久化生命周期证据对账，但不能仅凭闲置时间推断终止成功。

History 保留用户关心的上下文，例如 Agent 身份、任务或 workspace、时间和结束原因。具体持久化字段属于内部 schema，可以在不改变本产品契约的前提下演进。

## 失败语义

无法证明 Runtime 已终止时，不能报告清理成功。如果 Runtime 终止成功但 History 持久化失败，Farming 可以完成 live 生命周期，但必须单独暴露归档失败，不能声称 History 已经记录。History 筛选、详情页和从 History 重新启动属于展示或后续工作流，不改变生命周期 owner。

## 验证策略

确定性测试应覆盖主动终止、不活跃策略选择、自然退出、Main Agent 排除、重复终态观测、持久化失败和重启对账。浏览器测试应验证 live Agent 只在终态结果之后消失，并且对应归档摘要只展示一次。
