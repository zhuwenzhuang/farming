# Agent 列表状态协议

> English version: [agent-list-state-protocol.md](./agent-list-state-protocol.md)

Farming 后端拥有 Agent 列表及列表级元数据的权威状态。浏览器界面通过快照加增量协议消费该状态，不能从 Terminal 或 Chat 流量中推测缺失状态。

首次连接、显式重新同步或从传输背压恢复时，客户端会通过渐进分页接收一份逻辑完整快照。首次加载时，第一个有界 Page 可立即渲染；恢复期间，客户端保留上一份完整 Inventory，同时组装替代快照，并在完成时切换为精确的权威 Inventory。后续 Page 使用相同 Snapshot ID、Generation 与 Sequence，并按精确 Offset 追加。只有标记 `complete` 的 Page 达到声明的 Total 后，客户端才接受列表 Delta。Page 缺失、乱序、身份不匹配或中断时，客户端会请求新的权威快照，并由新的第 0 Page 替换正在组装的不完整快照；每个 Partial Page 和 Resync 都有有界 Deadline。第 0 Page 还会携带同一 Snapshot Sequence 下的权威 Project Agent 总数、活跃数、未读数、Zombie 数和最高 Attention Score。Code 只在个体 Inventory 尚未完整时使用这些聚合；完成后，普通 Agent 与 Live-state Update 会驱动 Browser 中的增量 Per-Project Summary，并继续作为持续变化行状态的权威来源。因此在恢复期间，新聚合表头可能会暂时与上一份完整 Inventory 的行共同显示，直到替代 Inventory 完成为止；这个有界混合视图保留监督覆盖，但不会把旧行视为新快照的一部分。Server 会在第一页后让出执行，并在该 Client 的传输 Buffer 超过 State 阈值时暂停后续 Page。分页期间的列表 Mutation 会进入有界的 Client Delta Sequence，并在最后一页之后排空；队列溢出时才回退为一份新的权威快照，避免无限内存增长或 Sequence Gap。之后的列表变化只携带发生变化的 Agent 完整摘要、被删除的 Agent ID，以及发生变化的列表级元数据。Terminal 输出、Chat transcript、预览和活动状态继续使用各自的 Agent 级数据流。

Browser View 会声明 Agent Activity 对全部 Agent、仅当前 Focused Agent，还是完全不相关。Farming Code 在 Projects 侧边栏可见时保留全部 Activity，在非 Agent View 中暂停；Farming CRT 在 Dashboard 上保留全部 Activity，打开单个 Session 后只订阅 Focused Agent。未声明 Scope 的 Client 继续采用兼容的 `all` 行为。

Agent 列表 Delta 具有独立的 Browser 级 `all` 或 `focused` Scope。Farming CRT 打开单个 Session 时使用 `focused`。Browser 仍会接收每个全局列表 Sequence：Focused Agent 的 Mutation 携带该 Agent，无关 Mutation 则携带空 Checkpoint 以及发生变化的列表级 Metadata。这样无需发送或应用无关 Agent Record，也能保留精确前序检查。切换 Focused Target 或返回 `all` 时，必须先接收新的权威 Snapshot，才能恢复广域监督。首次和恢复 Snapshot 仍然完整；未声明该 Scope 的 Client 继续使用 `all` Delivery。Agent-scoped `agent-update` 与 `agent-read` Message 遵循同一 Scope；权威 Snapshot 会协调 Focused 期间有意跳过的 Update。Focused Scope 中保留自上一份完整 Snapshot 的非目标 Agent Record 会被隐藏，并且有意保持过时；在下一份 `all` Snapshot 完成前，它们不能作为当前状态证据。

Session Preview 具有独立且向后兼容的 `all`、`focused` 或 `none` Scope。该 Scope 同时约束实时 Preview Broadcast，以及完整 Agent Snapshot 结束后的绝对 Preview Hydration。Focused CRT Session 使用 `none`，因为其权威 Live Terminal 或 Chat Surface 已经拥有当前可见内容；CRT Dashboard 使用 `all`。未声明该 Scope 的 Client 保持 `all` Delivery。扩大 Preview Interest 或切换 Focused Target 时会发送当前绝对 Preview Checkpoint；若 Agent Snapshot 已经必需或正在进行，则由其完成阶段执行该 Hydration。`none` Hydration 不遍历 Agent Inventory，`focused` 只精确读取一个 Agent，只有 `all` 才枚举完整 Preview Inventory。缺少精确 Agent Identity 的 Preview 会被拒绝，并只产生一次有界 Server Diagnostic，不会作为无 Owner 消息广播。Terminal Preview Text 或 Screen 的变化仍只通过这个受 Scope 约束的重数据流发送。当仅 Preview 发生变化并改变派生的 Terminal Status 时，后端还会发布一条去重的 `agent-update`，其中包含该 Status 及其对应的 Runtime Observation；如果同一帧还改变了 Agent Title，则由权威 State Delta 承担该状态，不重复发送轻量 Update。这样 Browser 即使有意不消费重 Preview，Project 监督状态仍保持最新，同时不会为每一帧 Preview 增加 Update。该轻量 Projection 遵循 Agent-state Scope，而不是 Preview Scope。Terminal Preview Event 不能写入由 ACP 拥有的 Agent Runtime Observation。去重基线会由权威 Agent-state Projection 和结构化 Terminal Metadata Update 共同刷新，因此两类来源交替时也不会隐藏后续由 Preview 派生的状态转换。

Activity Message 是可替换的绝对 Projection。慢速 `focused` Client 只保留一个待恢复的 Agent Checkpoint Marker；慢速 `all` Client 也只保留一个 Marker，并通过一份紧凑的权威 Activity Snapshot 恢复，不逐条重放 Update，也不发送完整 Agent State 或所有 Preview。从 `focused` 或 `none` 返回 `all` 时，只有该 Connection 确实遗漏过 Activity 才发送这份 Snapshot。

Adaptive Agent Title 会先发布 Agent-scoped Optimistic Patch，同一 Agent 的重复 Title 共用一个待完成的 Durability Result，并用最新排队值替换旧值。Admission 要求 Agent 的 Create Intent 已经建立持久化 Session Record，Title Update 不会隐式创建或认领 Record。持久化 Metadata Read、临时文件写入与 `fdatasync` 使用异步文件 I/O。Generation Check 会阻止已经准备好的旧 Title 覆盖并发 Lifecycle Metadata Commit；发生冲突时会在有界预算内重新读取最新 Record、重新解析 Provider Session 的 Canonical Record，并验证 Runtime Owner 仍是发起请求的 Agent。只有原子发布完成后才确认成功；失败时，如果该失败值仍是当前 Title，则回滚可见状态；Shutdown 会排空所有已接受的 Title Operation。

后端根据精确的 Agent 与集合 mutation 更新列表投影。同一广播窗口内的 mutation 按 Agent ID 合并，因此普通 delta 的构造成本与实际变化的工作集成正比，而不是与完整 Agent 数量成正比。只有首次连接和恢复快照才构建完整 Agent payload，并通过有界 Page 发送；恢复快照会用当前权威状态替换任何可能遗漏的 mutation。第一个 Page 必须包含 Main Agent，避免客户端在后续 Page 到达前误判 Main Runtime 缺失。

每个快照和增量都带有后端 generation 与递增 sequence。客户端只应用当前 generation 中紧接着的 sequence。遇到后端重启、序号缺口或不确定传输时，客户端请求新的权威快照，而不是自行猜测、重放 mutation 或引入逐消息确认。
