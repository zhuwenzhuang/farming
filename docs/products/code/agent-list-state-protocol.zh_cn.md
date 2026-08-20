# Agent 列表状态协议

> English version: [agent-list-state-protocol.md](./agent-list-state-protocol.md)

Farming 后端拥有 Agent 列表及列表级元数据的权威状态。浏览器界面通过快照加增量协议消费该状态，不能从 Terminal 或 Chat 流量中推测缺失状态。

首次连接、显式重新同步或从传输背压恢复时，客户端会通过渐进分页接收一份逻辑快照。默认 Snapshot 包含完整 Agent Inventory；已经拥有精确前台 Agent Identity 的 Client 可以在 Protocol Hello 中声明初始 `focused` State Interest，此时 Snapshot 只包含 Main Agent 和精确的 Focused Agent。Snapshot Page 的 `total` 表示本次 Scoped Record 数，第 0 Page 另行携带权威的全局 Live Agent 总数和 Running Agent 总数。Focused Target 不存在时会得到一份有界的 Main-only Snapshot；Client 必须显式扩大到 `all` 并请求新的权威 Snapshot，不能把 Scoped Projection 中的缺失当作全局不存在。未在有界声明窗口内完成 Hello 协商的旧 Client 会兼容回退到完整 Snapshot。Snapshot Complete 表示当前声明的 Projection 已完整；全局 Project Summary 与 Inventory Total 仍是权威 Metadata，但不代表 Focused Client 已保存每一条 Agent Record。首次加载时，第一个有界 Page 可立即渲染；恢复期间，客户端保留上一份完整 Inventory，同时组装替代快照，并在完成时切换为精确的权威 Inventory。后续 Page 使用相同 Snapshot ID、Generation 与 Sequence，并按精确 Offset 追加。只有标记 `complete` 的 Page 达到声明的 Total 后，客户端才接受列表 Delta。Page 缺失、乱序、身份不匹配或中断时，客户端会请求新的权威快照，并由新的第 0 Page 替换正在组装的不完整快照；每个 Partial Page 和 Resync 都有有界 Deadline。第 0 Page 还会携带同一 Snapshot Sequence 下的权威 Project Agent 总数、活跃数、未读数、Zombie 数和最高 Attention Score。Code 只在个体 Inventory 尚未完整时使用这些聚合；完成后，普通 Agent 与 Live-state Update 会驱动 Browser 中的增量 Per-Project Summary，并继续作为持续变化行状态的权威来源。因此在恢复期间，新聚合表头可能会暂时与上一份完整 Inventory 的行共同显示，直到替代 Inventory 完成为止；这个有界混合视图保留监督覆盖，但不会把旧行视为新快照的一部分。Server 会在第一页后让出执行，并在该 Client 的传输 Buffer 超过 State 阈值时暂停后续 Page。从 Snapshot Cut 到最后一页之间，`state-delta`、`agent-update`、`agent-read` 与 ACP Session Revision 共用一个有界的 Per-client Post-snapshot Queue。队列会在最后一页之后按原始发送顺序排空；每条受 Scope 约束的 Message 都会在真正发送前重新检查 Browser 当前的 Interest。可替换的 Activity 与 Preview Update 不占用该队列；Snapshot 完成后会按当时独立 Scope 恢复它们最新的绝对 Checkpoint。分页期间若 State Scope 发生变化，Server 会放弃已经过时的 Partial Snapshot，并按新 Scope 开始一份权威 Snapshot。队列溢出时同样放弃 Partial Result，并发送一份兼容的单页权威 Checkpoint，从而提供有界完成路径，避免内存无限增长、重复重启 Progressive Snapshot、出现 Sequence Gap，或让较新的 Hot Projection 被较旧的最后一页覆盖。之后的列表变化只携带发生变化的 Agent 完整摘要、被删除的 Agent ID，以及发生变化的列表级元数据。Terminal Output 与 Chat Transcript 仍使用独立的 Agent-scoped Stream，因为 Agent-list Snapshot Reconcile 不会替换这些 Stream Reducer。

Browser View 会声明 Agent Activity 对全部 Agent、仅当前 Focused Agent，还是完全不相关。Farming Code 在 Projects 侧边栏可见时保留全部 Activity，在非 Agent View 中暂停；Farming CRT 在 Dashboard 上保留全部 Activity，打开单个 Session 后只订阅 Focused Agent。未声明 Scope 的 Client 继续采用兼容的 `all` 行为。

Agent 列表更新可以按浏览器分别选择范围：

- `all`：接收所有 Agent 的更新。Farming Code 和 CRT 总览页使用这个范围。
- `focused`：只接收当前打开的 CRT Session 对应的 Agent 记录。

使用 `focused` 时，浏览器仍会收到每一个全局序号。当前 Agent 发生变化时，消息会包含它的完整记录；其他 Agent 发生变化时，只发送一个空的序号检查点和最新的列表汇总信息，其中包括全局 Agent 总数和正在运行的 Agent 数量。这样既能检查消息是否连续，又不需要传输无关 Agent 的记录。`agent-update` 和 `agent-read` 也遵循相同范围。

断线重连或发现序号缺口时，继续使用当前范围。切换到另一个 Agent，或者从单 Session 返回总览页时，必须重新获取一份后端权威快照。在 `focused` 期间没有接收的其他 Agent 记录会保持隐藏和过期，直到新的 `all` 快照接收完成。没有声明初始范围的旧客户端继续使用兼容的 `all` 行为。

Session Preview 具有独立且向后兼容的 `all`、`focused` 或 `none` Scope。该 Scope 同时约束实时 Preview Broadcast，以及完整 Agent Snapshot 结束后的绝对 Preview Hydration。Focused CRT Session 使用 `none`，因为其权威 Live Terminal 或 Chat Surface 已经拥有当前可见内容；CRT Dashboard 使用 `all`。Farming Code 只对当前可见的 Terminal Agent 使用 `focused`，在 Chat 或非 Agent View 中使用 `none`。完整 Snapshot 结束后，Client 有一个有界的 100 ms 窗口声明 Preview Scope；Snapshot Delivery 和声明窗口都会抑制尚未声明 Client 的 Live Preview，显式声明会立即按请求执行 Hydration，持续未声明的旧 Client 则在 Deadline 按兼容的 `all` Hydration。每份完整 Snapshot 只拥有一次 Hydration Decision；替代 Snapshot 或 Connection Close 会取消上一份尚未执行的 Deadline。扩大 Preview Interest 或切换 Focused Target 时会发送当前绝对 Preview Checkpoint；若 Agent Snapshot 已经必需或正在进行，则由其完成阶段执行该 Hydration。`none` Hydration 不遍历 Agent Inventory，`focused` 只精确读取一个 Agent，只有 `all` 才枚举完整 Preview Inventory。缺少精确 Agent Identity 的 Preview 会被拒绝，并只产生一次有界 Server Diagnostic，不会作为无 Owner 消息广播。Terminal Preview Text 或 Screen 的变化仍只通过这个受 Scope 约束的重数据流发送。当仅 Preview 发生变化并改变派生的 Terminal Status 时，后端还会发布一条去重的 `agent-update`，其中包含该 Status 及其对应的 Runtime Observation；Codex Terminal 的 Model、Reasoning Effort 或 Service Tier 变化也通过同一条轻量 Agent-state 路径发布，因此后台 Agent Row 不依赖 Preview 新鲜度。如果同一帧还改变了 Agent Title，则由权威 State Delta 承担该状态，不重复发送轻量 Update。这样 Browser 即使有意不消费重 Preview，Project 监督状态仍保持最新，同时不会为每一帧 Preview 增加 Update。该轻量 Projection 遵循 Agent-state Scope，而不是 Preview Scope。Terminal Preview Event 不能写入由 ACP 拥有的 Agent Runtime Observation。去重基线会由权威 Agent-state Projection 和结构化 Terminal Metadata Update 共同刷新，因此两类来源交替时也不会隐藏后续由 Preview 派生的状态转换。

Activity Message 是可替换的绝对 Projection。慢速 `focused` Client 只保留一个待恢复的 Agent Checkpoint Marker；慢速 `all` Client 也只保留一个 Marker，并通过一份紧凑的权威 Activity Snapshot 恢复，不逐条重放 Update，也不发送完整 Agent State 或所有 Preview。从 `focused` 或 `none` 返回 `all` 时，只有该 Connection 确实遗漏过 Activity 才发送这份 Snapshot。

Adaptive Agent Title 会先发布 Agent-scoped Optimistic Patch，同一 Agent 的重复 Title 共用一个待完成的 Durability Result，并用最新排队值替换旧值。Admission 要求 Agent 的 Create Intent 已经建立持久化 Session Record，Title Update 不会隐式创建或认领 Record。持久化 Metadata Read、临时文件写入与 `fdatasync` 使用异步文件 I/O。Generation Check 会阻止已经准备好的旧 Title 覆盖并发 Lifecycle Metadata Commit；发生冲突时会在有界预算内重新读取最新 Record、重新解析 Provider Session 的 Canonical Record，并验证 Runtime Owner 仍是发起请求的 Agent。只有原子发布完成后才确认成功；失败时，如果该失败值仍是当前 Title，则回滚可见状态；Shutdown 会排空所有已接受的 Title Operation。

Fork Child 继承 Source Agent 当前有效的 Row Title。Backend 追加 `(1)`，并选择尚未被其他 Agent 或已 Admission 的 Child Start 占用的最小正整数后缀，再把结果持久化为 Child 的 Custom Title。因此 Provider Title Update 不会静默覆盖继承得到的 Fork Identity。

后端根据精确的 Agent 与集合 mutation 更新列表投影。同一广播窗口内的 mutation 按 Agent ID 合并，因此普通 delta 的构造成本与实际变化的工作集成正比，而不是与完整 Agent 数量成正比。只有首次连接和恢复快照才构建完整 Agent payload，并通过有界 Page 发送；恢复快照会用当前权威状态替换任何可能遗漏的 mutation。第一个 Page 必须包含 Main Agent，避免客户端在后续 Page 到达前误判 Main Runtime 缺失。

权威 Agent Row 不会等待可选的 Git Worktree Decoration。Worktree Refresh 通过有界的后台队列执行；同一个精确 Agent 尚未开始的旧请求可以被最新请求替代。删除 Agent 会取消其 Pending Refresh；已经在执行的结果仍必须同时匹配同一 Agent Record 与 Refresh Generation，才能发布列表更新。Git Command Timeout 或探测失败只会省略或清除可选 Decoration，不会改变权威 Agent Lifecycle。这个资源边界限制的是后台进程突发量，而不是 Agent 数量。同一精确且规范化 Git Common Directory 的仓库级 Worktree 枚举会在一个短暂且有界的时间窗口内复用；Lifecycle Postcondition Check 使用 Fresh Read，不会消费缓存的枚举结果。

每个快照和增量都带有后端 generation 与递增 sequence。客户端只应用当前 generation 中紧接着的 sequence。遇到后端重启、序号缺口或不确定传输时，客户端请求新的权威快照，而不是自行猜测、重放 mutation 或引入逐消息确认。

Farming Code 与 Farming CRT 保留各自的展示状态、渲染方式和页面生命周期策略，但共用浏览器侧协议 Reducer。两个界面都必须在消息入口校验规范的 Agent 状态 Server 消息，并使用同一套 Snapshot Cursor、Delta Sequence 与 Agent 列表合并规则。界面专属的投影与渲染必须留在这套共享协议状态机之外。

Server 启动时必须在等待 Terminal Host 枚举、ACP Binding 或 Transcript 加载之前，通过一次
聚合状态转换物化全部持久化 Main-page Agent 行。这些行保留持久化 Identity、Runtime Kind、
顺序和 Attention Cursor。有精确恢复证据的 Runtime 为 `pending` 或 `connecting`；只有 Indexed
Membership、没有 Live Host 证据的 Terminal 是明确的 `stopped` Placeholder。后续 Runtime 恢复
只更新已有行，不能逐个新增。只有用户真实点击 Stopped Provider-backed 行时，Client 才发送
一次精确 Session Resume Mutation；后台读取、Preview Hydration 和 Server Ready 都不得触发恢复。
打开 Binding 尚未恢复的 Chat 行时，读取会等待同一次权威恢复。权威 Native Host 结果中不存在
的 Terminal Runtime 必须在同一轮有界恢复中离开 `pending`，并继续以明确的 Stopped 或失败状态
可见，不能消失并退回 Provider History。缺失的当选 Main Terminal 会被标记为 Dead 并释放 Main
Identity，让 Client 只创建一个替代者；它不能作为 Pending Main Placeholder 永久阻断恢复。
如果 Native Host 枚举本身失败，受影响的 Terminal Row 会进入明确的 Recovery Error，同时保留
当选 Main Identity；系统不能靠猜测替换一个结果不确定的 Live Runtime。

折叠状态下的 Project Session 分页必须先切出窗口，再把已由 Live Agent 认领的 Provider Session
替换为对应 Agent Row。因此用户 Resume 只会替换当前窗口中的所选 Session Row，不会回填另一条
History Row 或让 Project 列表自动增长；只有显式的“显示更多”操作可以扩大窗口：初始窗口为 5 条，
第一次最多增加 5 条，之后每次最多增加 10 条，“显示较少”重置为 5 条。隐藏数量会排除
所有已经由 Live Agent 表示的 Session，无论该 Claim 位于当前窗口内还是窗口外。

Main Identity 必须唯一。旧版本 Record 含有多个 `wantsMain` Marker 时，启动流程会确定性选出
一个未进入普通 Session Index 的持久化 Main；已经进入 Index 的 Provider Session 仍投影为普通
Agent Row，且不会删除或批量改写历史数据。Main-page Membership 只证明该行属于 Inventory，
不能证明它在进程丢失前拥有 Live Runtime。因此 Server Ready 后不得自动 Resume 全部 Indexed
History Session；Native Host Rotation 也只能重启由旧 Host 提供了精确 Serialized Live State 的
Terminal。Stopped/History Session 只有收到显式用户 Resume 后才能启动 Runtime。

Farming 已绑定 Agent 的未读状态由单调 Attention Cursor 和 Read Cursor 共同拥有。每次持久化
Agent State 时，都必须从 Cursor 重新写入 `unread` Projection；旧版本留下的矛盾 Boolean
不能在启动期间或 Runtime 尚未恢复时重新出现。

## 动态置顶投影

当本地持久化的“动态置顶”偏好打开时，Farming Code 可以把最近活跃或需要用户关注的 Live Agent
投影到“已置顶”区域。这只是 Browser 展示投影：不会写入 Backend 拥有的 `pinned` 字段，不改变
手动置顶顺序，也不会动态提升 Main、已归档、已删除或只有历史记录的 Session。一个 Live Agent
只在一个位置出现；手动置顶保持现有顺序并排在前面，纯动态置顶按稳定的 Project 顺序排在后面，
中间没有分隔线，也没有第二套行样式。

未手动置顶的 Live Agent 在权威 Runtime Observation 为 Starting、Working 或 Waiting、状态为
Pending，或权威未读投影为 True 时持续符合条件。除此之外，它会在以下有效时间中的最新值之后
严格保留不足一小时：`lastActivity`（缺失时使用 `startedAt`）、Attention Update 或 Exit。
打开或查看 Agent 不计为活跃，Read Cursor 也不作为活跃时间来源。仍需关注时，现有相对时间显示为
`now`；关注状态结束后，
从最新的权威事件时间继续计算一小时。到达边界时，纯动态置顶行回到原 Project；手动置顶永不因此失效。

即使列表为空，“已置顶”表头也保持可用。铃铛按钮只控制动态投影并暴露按下状态；右上角未读点
独立反映当前未读 Inventory，与动态置顶是否打开无关。关闭偏好时，已置顶与 Project 行行为保持
不变；打开后，每一条完整的已置顶行即使在较窄侧边栏也显示现有相对活跃时间，Hover 或键盘聚焦
行操作时仍由操作按钮替代时间。

动态置顶复用页面可见时已有的相对时间时钟检查一小时边界，不新增 Heartbeat、Polling、Lease
或持久化的 Per-Agent Timer。Reload 后从 Backend Agent 状态重建资格。

Project 级“归档会话”只作用于仍位于该 Project 区域中的 Row。手动置顶的 Session 与 Agent，
以及当前由动态置顶投影到“已置顶”区域的 Live Agent 都受保护。“移除项目”是另一项需要确认的
清理操作，仍会释放该 Project 关联的全部 Agent 与 Main-page Session，包括置顶 Row。
