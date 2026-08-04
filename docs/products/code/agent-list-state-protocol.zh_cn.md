# Agent 列表状态协议

> English version: [agent-list-state-protocol.md](./agent-list-state-protocol.md)

Farming 后端拥有 Agent 列表及列表级元数据的权威状态。浏览器界面通过快照加增量协议消费该状态，不能从 Terminal 或 Chat 流量中推测缺失状态。

首次连接、显式重新同步或从传输背压恢复时，客户端接收完整快照。之后的列表变化只携带发生变化的 Agent 完整摘要、被删除的 Agent ID，以及发生变化的列表级元数据。Terminal 输出、Chat transcript、预览和活动状态继续使用各自的 Agent 级数据流。

Browser View 会声明 Agent Activity 对全部 Agent、仅当前 Focused Agent，还是完全不相关。Farming Code 在 Projects 侧边栏可见时保留全部 Activity，在非 Agent View 中暂停；Farming CRT 在 Dashboard 上保留全部 Activity，打开单个 Session 后只订阅 Focused Agent。未声明 Scope 的 Client 继续采用兼容的 `all` 行为。

Activity Message 是可替换的绝对 Projection。慢速 `focused` Client 只保留一个待恢复的 Agent Checkpoint Marker；慢速 `all` Client 也只保留一个 Marker，并通过一份紧凑的权威 Activity Snapshot 恢复，不逐条重放 Update，也不发送完整 Agent State 或所有 Preview。从 `focused` 或 `none` 返回 `all` 时，只有该 Connection 确实遗漏过 Activity 才发送这份 Snapshot。

Adaptive Agent Title 会先发布 Agent-scoped Optimistic Patch，同一 Agent 的重复 Title 共用一个待完成的 Durability Result，并用最新排队值替换旧值。Admission 要求 Agent 的 Create Intent 已经建立持久化 Session Record，Title Update 不会隐式创建或认领 Record。持久化 Metadata Read、临时文件写入与 `fdatasync` 使用异步文件 I/O。Generation Check 会阻止已经准备好的旧 Title 覆盖并发 Lifecycle Metadata Commit；发生冲突时会在有界预算内重新读取最新 Record、重新解析 Provider Session 的 Canonical Record，并验证 Runtime Owner 仍是发起请求的 Agent。只有原子发布完成后才确认成功；失败时，如果该失败值仍是当前 Title，则回滚可见状态；Shutdown 会排空所有已接受的 Title Operation。

后端根据精确的 Agent 与集合 mutation 更新列表投影。同一广播窗口内的 mutation 按 Agent ID 合并，因此普通 delta 的构造成本与实际变化的工作集成正比，而不是与完整 Agent 数量成正比。只有首次连接和恢复快照才构建完整 Agent payload；恢复快照会用当前权威状态替换任何可能遗漏的 mutation。

每个快照和增量都带有后端 generation 与递增 sequence。客户端只应用当前 generation 中紧接着的 sequence。遇到后端重启、序号缺口或不确定传输时，客户端请求新的权威快照，而不是自行猜测、重放 mutation 或引入逐消息确认。
