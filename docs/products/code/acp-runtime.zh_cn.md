# ACP Runtime

> English version: [acp-runtime.md](./acp-runtime.md)

Farming 使用 Agent Client Protocol 为受支持的 Coding Agent 提供结构化 Chat。Backend
拥有 Runtime 生命周期、Provider Session、有序 Chat 状态、配置、权限与恢复；Browser
界面只展示权威状态，不从普通文字或 Terminal Output 中重新推断。

## Provider 边界

Provider 特有的 Executable Discovery、Environment、Adapter Patch、可选方法和 History
行为都属于 Provider Adapter。通用 Lifecycle 与 Chat 只使用实时协商的 ACP Capability，
不得根据 Provider 名称猜测支持情况。

稳定的 Provider Catalog 与 Adapter 也是 Launch Metadata、Runtime Switching、Terminal
Input Behavior 及 Session/Inventory Policy 的唯一来源。Browser 与 CRT Surface 只消费
该边界投影出的 Capability，不维护 Provider Name Allowlist，也不重复定义 Provider Default。

Provider Launch 与 Recovery Profile 通过 Adapter Policy 投影。Permission Key、Model 与
Reasoning Field、Resume 时的继承规则、Display Name 及已退役 Request Alias 都属于 Provider
边界；通用 Agent Lifecycle 只消费归一化结果，不再根据 Provider Name 分支。

Provider History Mutation 使用同一边界。Archive，以及 Resume 或 Fork 前的 Unarchive
支持，由 Provider History Mutation Registry 声明并执行；通用 Resume、Fork、Recovery 与
Archive Flow 只传递精确 Provider Identity，不直接调用 Provider-specific Command。
归档 Detached History-backed Row 时，只有受支持的 Provider Mutation 成功后才提交 Main-page
Membership Removal；失败时 Membership 保持不变，使同一 Row 仍可继续操作。
Archive 与完整的 Non-Fork Resume Admission 按同一个精确 Provider Session Identity 串行。
Resume 从权威 Lookup、可选 Unarchive 一直持有该 Admission，直到新 Agent 建立 Claim；
Unarchive 在已持有的 Admission 内执行，不会再次进入同一个 Mutation Coordinator。

性能、正确性、可靠性、恢复、隔离与可观测性都是 Provider-neutral 的 ACP 要求。
横切改进只有在所有受支持 Provider 都满足同一 Adapter Contract 与等价验收标准后才算
完成。Provider 集成可以用不同方式实现该 Contract，但不得绕过它，也不能把单一 Provider
实现描述为通用 ACP 优化。

ACP 与 Native Terminal 使用相互独立的 Executable Policy。ACP 使用 Farming 自有、版本
锁定的 Runtime Artifact；Terminal 遵循 Native Terminal Policy。更新 ACP Pin 必须验证
Protocol、Integrity、Recovery 与 Chat/Terminal Compatibility。

Native Terminal Executable Discovery 只返回一种归一化 Compatibility Result。Provider
特有的 Resume Version 要求与受信 Test Override 留在 Executable Discovery Registry；Agent
Lifecycle 不选择 Provider-specific Resolver。

默认 ACP Launch 是不可变的 Farming-managed Image，统一绑定 Adapter 版本、Provider CLI
版本、Protocol/Build Identity、Patch，以及 Node 或兼容 Loader 的启动方式。新建 Chat
Session 始终使用这套 Managed Runtime；Plugins 不再提供第二条 Executable Selection Path。
已有 Session 保留创建时的精确 Launch Identity，使旧 Custom Binding 能恢复且不会被静默
重绑。环境变量只作为兼容输入，不是普通用户配置的 Authority。
加载设置时会移除已退役的 Agent Home 级 Custom Runtime 选择；如果已有 Session 的持久
Launch Identity 仍引用该 Executable，则不会删除它。
已有 Session 如果缺少创建时记录的精确 Executable，恢复必须 Fail Closed，且不得按当前
机器环境重新发现 Executable。
Terminal Session 尚未选择 ACP Executable。把同一个 Provider Session 切换到 Chat 时，
Farming 从其精确 Agent Home 选择 Managed ACP Runtime，并在启动前持久化该 Launch Identity；后续 ACP
恢复只能使用这份持久化 Executable。

Pi 使用 ACP 官方 Registry 收录的 Adapter，并由 Farming 作为 Version 与 Integrity 固定的 Artifact
持有。Adapter 启动精确发现到的 System Pi Executable；启动前会验证 Adapter 要求的 Pi 0.80.4
最低版本，并独立持久化 Absolute Executable Identity。
Farming 把 Adapter State Patch 到所选 Agent Home 下精确的 Config 与 Agent Namespace，并显式
注入共享 Bootstrap；绝不使用上游的 Global State Path。由于 `pi-acp` 每条 Connection 只支持一个 Live Pi Subprocess，每个 Pi Chat
拥有私有 ACP Adapter Process。Adapter 0.0.33 不转发 ACP MCP Server，不委托 Client Filesystem
或 Terminal Operation，也不声明 Permission 或 Fork Capability。这些缺口保持为可见 Capability
边界，不能推测为已支持。每轮结束后，Farming 把 Pi 的权威 Session Statistics 映射为 ACP
Usage Update，因此 Chat 的 Context Usage 与 Cost 使用 Live Pi Session 的真实值。Pi Session History
可以索引默认目录或已配置的绝对目录。Pi 会相对
Launch Working Directory 解释 `settings.json` 中的相对 `sessionDir`，因此 Farming 不猜测该目录；
需要 Farming Inventory 时，应在所选 Pi Agent Home 的 `settings.json` 中配置绝对 `sessionDir`。

只有 Live Agent 明确声明时，Farming 才启用标准 ACP Session、Prompt、Cancel、Config、
Authentication、Elicitation、Terminal、Media、Plan 与 Fork 能力。Provider Extension 必须
带版本、可协商，并留在 Adapter 边界。

Qwen Code 的 v1 Prompt Suggestion Notification 会在该边界归一化为临时、Provider-neutral
的 Composer State。它可以替代空输入框的 Follow-up Placeholder，并通过 Tab 填入草稿，
但不会成为 Transcript Entry，也不会写入持久 Checkpoint。新 Prompt 会使旧建议失效；没有
发送该 Extension 的 Provider 继续显示普通 Placeholder。

## Runtime 所有权

每个 Config Instance 有一个 ACP Runtime Host。Farming Server 是可替换 Controller；Host
拥有 Live Provider Connection、Active Operation、有序 Reducer 和进程身份。兼容 Server
重启会重连 Host，并读取其权威 Checkpoint 与 Delta，而不是重启健康 Session。

上述 Server-only 重连属于故障恢复行为，不是 Farming 的主动 Stop Mode。Farming 只有一种
主动 Stop 语义：直接杀掉选中的、由 Farming 拥有的全部进程，不做 Graceful Shutdown 或 Drain、
Handoff，也不保留或复用进程。这个单一的 Hard-stop 契约用于刻意简化状态管理，也用于保证
状态机正确性：Graceful 路径会增加第二种终止场景，并可能隐藏只有突然终止才会暴露的问题，
因此 Recovery 与 Cleanup 必须以 Hard-stop 为准。仓库的 `npm restart` 命令会完整停止
Farming 后全新启动；其性能优化必须改进冷启动 Inventory 与 Session 恢复。
Linux 上的退出验证会把只剩已退出 Zombie Entry 的进程组视为已停止；只要仍有
可运行、睡眠或暂停的后代进程，Cleanup 就必须继续失败关闭。

ACP 不设置固定 Agent、Session、Process、Thread 或并发数量上限。资源保护来自有界 Queue、
Payload、Cache 与 Backpressure，不能用任意 Live Agent 限制代替真实性能治理。

只有 Provider 支持独立 Multi-Session 时才能共享 Provider Runtime。参考 Zed 的 External
Agent 连接边界，共享 Pool 限定在一个 Canonical Project 内，并以 Provider、Canonical Agent
Home 与 Adapter Launch Identity 为 Key。每个 Session 仍独立拥有 Workspace、Provider
Session ID、配置、权限、身份、MCP Scope、Active Turn 与 Recovery State；在一个 Runtime
Host 内，一个 Provider Session 在全部 Project Pool 中最多只有一个 Live Owner。关闭或删除
一个 Session 不能停止同 Pool 的无关 Session。共享 Runtime 失败时必须对账全部受影响
Session，且绝不重放结果不明确的 Prompt。
Session 进入 `connecting` 后、Farming 获取 Provider Process 前，会在所选 Agent Home 不存在
时创建它，并解析其 Canonical Identity。Home 准备失败会成为显式 Session Failure，绝不
Fallback 到其它 Home 或 Executable。
Codex、Claude、OpenCode、Qoder、Qwen 与 Pi 都使用该 Connection 边界。与 Zed 一致，只有
Provider 明确声明 `session/close` Capability 时才发送关闭请求；否则 Farming 只释放本地
Session 引用，并在 Project Connection 的最后一个 Session 结束时回收 Provider Process。

Browser 与 Computer 使用实例精确的 Farming CLI 和共享 Backend Service，不再为每个 Agent
启动一份 Capability 子进程。每个 ACP Session 通过 Session-scoped Environment Metadata
获得自己的 Agent 与 Project Identity；CLI 调用携带该本地身份，Backend 直接解析当前 Agent
与 Project Workspace。Identity 与其它 Farming Operational Context 绝不能追加到用户 Prompt。
Agent 名字只用于路由，不是单独的授权 Credential。Farming 不向 ACP Session 注入自有
Capability MCP Entry；Provider 与用户 MCP 配置仍是私有 Session Input。

Farming Bootstrap 只包含 Provider-neutral 的操作指令，不定义用户偏好的回复语言。对于只有
标点或其它 Language-neutral 的输入，不得从 Bootstrap、UI Locale、Agent Identity、Workspace
Metadata 或隐藏 Operational Context 推断回复语言。

## Session 身份与配置

ACP Conversation 的稳定身份由 Provider、Canonical Agent Home、Provider Session ID 与
Workspace Scope 共同组成。Additional Directory 与 MCP Definition 是私有 Session Input，
必须在重连、重启和 Runtime Replacement 后保留，但不能作为普通 Browser State 暴露。

Provider Adapter 声明 Provider Session ID 是按单个 Agent Home 隔离，还是在该 Provider 内
全局唯一。对于全局 Provider Identity，Persistence Layer 会拒绝把同一 Session ID 绑定到
第二个 Agent Home；通用 Storage 不按 Provider 名称识别这类规则。

标记为 Temporary 的 Session Plan 不是已确认的 Provider Identity，不能通过 Provider
History 解析；该规则对所有 Provider 一致生效，直到 Adapter 特有的 Identity Evidence 被确认。

配置有两类权威来源：

- 没有用户显式 Override 时，由已加载的 Provider Session 与所选 Agent Home 提供默认值；
- 用户修改得到确认后，Farming 只持久化这项显式 Override，并在加载 Provider Session 后
  重新应用。

Override 只能按稳定 Option Identity 匹配，不能按展示 Label 猜测。保存的 Option 或 Value
不再支持时，Farming 保留 Provider 当前值，只删除不兼容 Override，并显示恢复警告，不让
Session 整体不可用。Transport Failure 不能证明 Override 永久不兼容。

## Turn 与 Mutation 语义

同一 Session 中互相冲突的 Prompt、Steer、Cancel、Config 与 Child Control 必须按明确顺序
准入。每个 Operation 都绑定当前 Binding 与 Turn；Replacement Binding 之前的迟到结果不能
修改当前状态。

Prompt Submission 有明确身份。相同请求的重复提交可以加入已有结果，内容不同的同 ID 请求
必须拒绝。Transport Failure 导致 Provider Ownership 不确定时，Farming 不会自动重放 Prompt
或 Steer。Cancel 精确指向当前 Active Turn，并到达可见终态。

Queued Follow-up 在准入开始前保持可编辑、可丢弃。协商成功的 Live Steer 保留在所属 Turn
内部；不支持 Steer 的 Provider 使用可见 Queue。

Farming 从 Agent 的 Initialize Response 协商标准 Steering，并且只在拥有 Active Turn 时
调用 `_session/steering`。旧 Codex Steer Extension 仅作为 Adapter Boundary 的兼容路径，
用于尚未声明标准能力的 Agent。已接受的 Steering 使用 Provider-neutral Farming Metadata
记录，从而让所有支持该能力的 Agent 具有一致的 Transcript 与 Composer 行为。

Composer 中的 Goal 输入被明确视为 Prompt Content，而不是持久 ACP Goal Binding。Farming
不会根据该输入创建跨 Turn Goal 状态；提交的文字本身就是完整事实来源。

## Transcript 协议

Backend 把 History Replay 与 Live ACP Update 归约成一条有序、Provider-neutral Transcript。
Text、Reasoning、Tool、Patch、Plan、Terminal、Media、Resource、Permission 与 Child Session
保持结构化；UI 不得先压平成普通文字再反向解析。

Browser Delivery 使用严格 Checkpoint + Delta 契约：

- Checkpoint 标识精确 Agent、Provider Session、Runtime Epoch 与 Transcript Revision；
- Delta 只能应用到相同 Epoch 和精确前序 Revision；
- 发现缺口、Identity 变化或 Reset 时必须请求 Replacement Checkpoint；
- 其它 Agent 或旧 Revision 的迟到响应不能抢回当前 Chat。

每个 Browser Connection 都会显式声明当前可见 Agent，以及它拥有结构化 Transcript 的有界
Retained ACP Chat 集合。ACP Revision Notification 只投递给 Interest 匹配的 Connection。
切换 Focus、新增 Retained Interest 或重连时，会把当前绝对 Cursor（Agent、Provider Session、
Runtime Epoch 与 Transcript Revision）作为 Agent-scoped Checkpoint 发送。Session 或 Epoch
被替换时，即使 Revision 从更小数字重新开始也必须投递。
慢连接对每个 Interested Agent 只保留一个 Pending Checkpoint Marker，并在
Transport Buffer 排空后恢复最新 Revision；不会按每次 Provider Update 累积一条待发送通知。

HTTP Transcript Read 在跨进程读取前后分别采样权威 Session 与 Runtime Epoch；Identity 发生
变化或返回 Transcript 指向其它 Session 时拒绝该响应。读取期间 Transcript Revision 可以继续
前进；持续工作的 Agent 不需要等待 Revision 静止，仍可返回 Identity 自洽的结果。

Provider Replay 是权威来源。Local Checkpoint 可以加速投影并保留 Reset Fence，但除非 Provider
能证明 Freshness，否则不能替代完整 Load。结果不确定的 Prompt 会让 Checkpoint 保持 Dirty。

有序 Session Reducer 保持 Provider-neutral。标准 ACP 之外的 Transcript 细节——例如内部上下文
作用域、压缩文本识别、消息 Phase 边界与重复消息对账——归所选 Provider Transcript Policy
所有。某个 Provider 的可见输出即使碰巧匹配另一 Provider 的文字，也不得继承后者的文本
启发式规则。

打开 Chat 时应立即显示 Shell；存在合法 Prepared Checkpoint 时，首份稳定 Transcript 应在
数十毫秒内可见。Prepare 只在 Backend 中根据明确 Interest Signal、并等待系统稳定后执行。
它可以取消，受 Revision Fence 保护，并对 Entry 数、单响应大小、总 Cache 与 Active Work
分别设界。失败或淘汰时回退到同一条权威 On-demand Read。

首份稳定 ACP Transcript 只包含最新 5 个 Turn。用户向上阅读时，再按有界批次加载更早的
Turn，避免打开长 Chat 时把全部 Markdown 与工具历史放入首屏渲染路径。

Browser 为最近 Chat 保留有界 LRU 的完整结构化 Transcript Record，其中包括用户已经向上加载的
更早 Turn 范围。Retained Record 在 Inactive 时继续合并 Live Revision；每个 Agent 的 Revision
只合并到一个最新 High-water，每个 Agent 只允许一个 Transcript Read in-flight，同时对后台读取
Cadence 与全局读取并发设界。只有当前可见 Chat 持有 React、Markdown 与 Tool Card DOM。
重新 Attach 的 Retained Record 如果已观察到的 Session 与 Runtime Epoch 仍匹配，就立即显示，
并从现有 Revision 继续；不能只因为它重新可见就请求 Checkpoint。冷启动或已淘汰的 Chat、重连、
Identity 变化、检测到缺口、Reset 或分页范围变化，仍必须先取得权威 Checkpoint，才能显示替换
内容。阅读位置绑定稳定 Turn 或 Process Item，而不只记录 Pixel；Transcript Record 与 Pooled
Terminal 共用 20-view Working-set 边界。

ACP Session 控件沿用同一套 Agent-scoped Working-set Ownership。Browser 会保留最近每个
Agent 最后一次已确认的 Mode、Model、Reasoning、Permission 与 Account Snapshot，切换到
其它 Chat 时不会清空。切回时同步显示该 Confirmed Snapshot，同时发起新的权威 Session Read
做 Revalidation。在该读取确认当前 Agent 与 Runtime Revision 之前，保留控件保持可见但不可
操作。Revalidation 失败会显示错误、保留最后确认的画面，并继续禁用控件；从未加载或已经淘汰
的 Agent 仍需等待第一份权威 Snapshot。Refresh 与 Mutation Response 继续由精确 Agent
Identity 和 Request Sequence 保护；归档或 Working-set Eviction 只销毁对应 Agent 的
Retained Snapshot。

Provider-wide Discovery 归 Shared ACP Runtime 所有，而不归单个 Session 所有。同一 Provider
Home 与 Project 的并发 Session Open 必须合并 Skills 与 Model Discovery。一次已经完成的
Discovery Result 不能作为后续 Session Open 的权威缓存：后续 Open 必须强制重新读取 Skills，
并取得新的 Model Inventory。Authentication 或 Provider Routing 改变时必须推进 Discovery
Generation；更早的 In-flight Model Result 在使用前必须重新读取。失败的 Discovery 不得缓存。
Session 自己的 History Restore 仍保持权威并可能耗时，但并发 Open 不能串行等待重复的
Runtime-wide Discovery 工作。

## 生命周期与恢复

有业务意义的 Session 状态包括 Connecting、Idle、Working、Waiting for User、Interrupting、
Recoverable Error 与 Terminal Failure。Idle 是普通 Live State；Session 会一直保持 Live，
直到用户归档、系统替换或清理它，或精确证明 Runtime 已失败。

Adapter 或 Host 异常退出必须进入明确恢复或失败。恢复需要证明旧进程 Ownership，恢复同一
Provider Session 与私有 Scope，重新加载权威 History，并保留显式 Config Override。断线时
正在执行的 Turn 结束为失败或不确定，绝不能静默重放。
恢复与重连本身不属于 Agent 活跃，不能推进持久化 Last Activity；只有真实 Runtime 工作或
用户注意力事件才推进该时间。恢复失败时间属于 Lifecycle Evidence，不属于活跃。
重连或替换后的 Host 如果不再持有之前观察到的 Binding，Farming 会先把该 Binding 标记为
Interrupted，并立即为精确的持久化 Provider Session 安排冷恢复；冷恢复成功时，这个短暂
Interrupted 状态不能成为 Session 的最终状态。

普通启动不会替换仍拥有 Live Chat Session 的不兼容 Host。显式全量重启可以主动接管该
Host、终止其 Live Session，并从持久化 Session Record 启动新的 Host。

全量重启选中的进程集合必须包含 ACP Runtime Host 及其全部 Provider 进程。如果停止后
仍能连接到旧 Host，新 Server 即使发现其协议与 Build 兼容也必须替换它；全量重启绝不能
重新接管旧 Host 代际。只有普通的 Server-only 重启可以接管兼容 Host 并保留 Live Session。

冷恢复会先一次性物化全部可恢复 Agent Inventory，再按持久优先级以有界并发准备 Provider
Session；单个 Session 失败不能阻断其余恢复。多个 Record 指向同一持久进程身份时，Farming
只对该身份执行一次精确 Hard-stop 证明，并让这些 Record 共享结果。并发完成顺序不得改变
既有 Main Page Membership 的顺序。

ACP Runtime Host 无法启动或重连时，只把受影响 Chat Session 标记为不可用，不得阻塞
Server Ready、Native Terminal Recovery、Files 或 Plugins。一个 Runtime Family 的恢复不能
成为无关 Runtime Family 的全局 Lifecycle Barrier。

Chat/Terminal 切换是真实 Runtime Replacement；只有证明可恢复时才保留同一 Provider
Conversation。Turn 活跃时拒绝切换。目标 Runtime 启动失败时，Farming 恢复原 Runtime 并
报告切换失败。

Conversation Fork 只有在 Adapter Contract 与 Live Capability 都支持时才可用。Source
Revision、Child Identity、Ownership 与 Cleanup Responsibility 必须精确；Child Durable 前
失败时必须显式报告，不能静默创建另一个 Fork。

Active Turn 默认仍是 Fork Barrier；只有 Provider Adapter Contract 显式声明支持 Active-Turn
Fork 时才可放行。该 Fork 必须使用 Active Turn 之前由 Provider 拥有的稳定 Boundary，保持
Source Turn 继续运行，并且不能复制不完整的 Assistant 或 Tool State。持续变化的 Transcript
Revision 不会让这个稳定 Boundary 失效；未声明该能力的 Provider 继续使用 Idle-only 规则。

不同 Runtime Strategy 共用一条 Fork Child Launch 落定规则：Callback 与 Promise
结果中先到者为准。Callback 明确失败或 Promise resolve null 属于确定失败，可执行精确
Cleanup；同步抛错或 Promise reject 属于不确定结果，Farming 必须保留精确的 Forked
Provider Session，在 Durable Reconcile 前不得删除或重放。

Farming 重启时若 Fork Operation 仍未终态，恢复会在任何 Runtime 启动前先对其收敛。
存在精确 Source Runtime Agent Identity 时，该 Operation 被转换为持久 blocked；若
blocked Transition 无法持久化，Journal 保留原 pending 事实，Source 仍以
lifecycle-blocked 的 fail-closed 状态恢复。缺少精确 Identity 时不猜测、不做
Transition：Operation 保持 pending 并给出显式告警。任何情况下 Fork 都绝不自动
重放，同一请求只能对持久结果做 Reconcile；当 Source 可寻址时，Archive 或 Delete
可以 Supersede 它。

## 展示契约

Chat 展示有序对话、当前 Turn 的一条紧凑 Live Activity，以及可逆的结构化证据。已完成的
Reasoning 与 Tool Detail 不应在默认阅读面上形成重叠摘要。Disclosure Control 保留稳定布局
槽位，只在 Hover 或 Keyboard Focus 时视觉浮现。中间 Tool 失败保留在所属 Action Group
内，但不替换该 Group 的行为摘要；权威 Turn 与 Runtime Failure 继续在更高层级显式展示。

文件提交后，历史 Patch Card 仍保留其结构化 Diff 证据。只有该 Card 中至少一个路径仍存在
当前 Staged、Unstaged 或 Untracked Git 改动时才显示 Commit Follow-up；无关的 Working Copy
改动不能让该操作继续显示。

新建 Chat 在 Session 连接期间持续显示稳定的空对话状态。Session 启动不属于 Active Turn，
不得启用 Steer，也不应使用短暂的启动文案替换空状态。新 Session 启动期间的 Transcript
读取失败不能替换该空状态；真实 Runtime Failure 仍通过权威 Runtime 与 Composer State 显示。
显式 History Restore 可以在首份权威 Transcript 稳定前显示有界的同步反馈。

Live Chat Agent 只允许显式用户重命名或 Agent-managed Adaptive Title 覆盖稳定 Provider 名称。
由第一条 Prompt 派生的 Provider Session Title 属于 History Metadata，不能重命名 Live Agent；
恢复的 History Agent 在没有更强标题来源时可以使用其持久 Provider Session Title。

尚未 Settled 但已包含 Turn 的权威 Transcript 必须立即进入显示，同时先在后台执行有界的快速
稳定重试，之后以更慢的恢复节奏继续对账，直到获得权威 Settled Response。只有“预期存在历史
但权威响应仍为空”时，Transcript 区域才继续显示同步反馈。

Live Transcript Revision 在已有读取进行中时进入合并队列，而不是反复取消该读取，因此持续
更新也能不断落屏，不必等待静默窗口。快速且仅推进 Revision 的刷新还会共享一段短促、有界的
读取节奏；最新 Revision 必须最终执行，而重连与 Runtime State 转换仍立即处理。已完成 Turn
在这些读取之间保持稳定渲染身份，不重新解析未变化的 Markdown。新出现的中间消息使用短促且
有上限的揭示动画；多条消息并行揭示，Reduced Motion 会关闭动画。
Reasoning 展开内容不再重复已经作为折叠标题的首行，并用安全 Markdown 渲染剩余正文，
让 Provider 输出的强调样式正常呈现，而不是暴露其源标记。

最新 Live Answer 会挂载每一份跨过有界 Revision 读取节奏的权威快照。Farming 不得把保持
前缀关系的正文一直扣留到 Turn 完成；用户应持续看到有序的中间进展，同时避免逐 Token
重绘。Navigation、Recovery 与 Turn 完成直接对齐当前权威结果，不重播已经收到的正文。

底部 Live Activity 同一时刻只使用一种动态提示：Processing 保留旋转圆圈且不显示扫光，
非旋转活动则使用速度较慢的匀速扫光。

Composer 保留 Draft、IME、Attachment、Queue/Steer、Permission 与协商配置。Reload 可以把
未完成 Submission 恢复成需要对账的可见条目，但绝不能自动再次提交。

## 验收标准

所有受支持 Provider 都必须针对其实现的 Contract 通过同一套 Provider-neutral 验证。验证
必须覆盖：Provider Capability Negotiation、精确 Identity 与 Agent Home 隔离、Config
Fallback、有序 Mutation、结果不确定、Server/Host 重启、Checkpoint/Delta 缺口、阅读位置
恢复、Chat/Terminal 切换、Fork、Media 与 Tool Evidence，以及大规模 Multi-Agent Workload。
Scale Test 必须测量 Process 数、Memory、Wire Volume、Browser Render Work 与 Navigation
Latency，不能设置固定并发上限。
