# ACP Runtime

> English version: [acp-runtime.md](./acp-runtime.md)

Farming 使用 Agent Client Protocol 为受支持的 Coding Agent 提供结构化 Chat。Backend
拥有 Runtime 生命周期、Provider Session、有序 Chat 状态、配置、权限与恢复；Browser
界面只展示权威状态，不从普通文字或 Terminal Output 中重新推断。

## Provider 边界

Provider 特有的 Executable Discovery、Environment、Adapter Patch、可选方法和 History
行为都属于 Provider Adapter。通用 Lifecycle 与 Chat 只使用实时协商的 ACP Capability，
不得根据 Provider 名称猜测支持情况。

性能、正确性、可靠性、恢复、隔离与可观测性都是 Provider-neutral 的 ACP 要求。
横切改进只有在所有受支持 Provider 都满足同一 Adapter Contract 与等价验收标准后才算
完成。Provider 集成可以用不同方式实现该 Contract，但不得绕过它，也不能把单一 Provider
实现描述为通用 ACP 优化。

ACP 与 Native Terminal 使用相互独立的 Executable Policy。ACP 使用 Farming 自有、版本
锁定的 Runtime Artifact；Terminal 遵循 Native Terminal Policy。更新 ACP Pin 必须验证
Protocol、Integrity、Recovery 与 Chat/Terminal Compatibility。

默认 ACP Launch 是不可变的 Farming-managed Image，统一绑定 Adapter 版本、Provider CLI
版本、Protocol/Build Identity、Patch，以及 Node 或兼容 Loader 的启动方式。Provider 加
Agent Home 可以在 Plugins 中显式选择自定义 Provider Executable；Custom 是独立 Launch
Identity，绝不静默回退 Managed Image 或 Terminal Executable。已有 Session 保留创建时的
精确选择。环境变量只作为兼容输入，不是普通用户配置的 Authority。

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

ACP 不设置固定 Agent、Session、Process、Thread 或并发数量上限。资源保护来自有界 Queue、
Payload、Cache 与 Backpressure，不能用任意 Live Agent 限制代替真实性能治理。

只有 Provider 支持独立 Multi-Session 时才能共享 Provider Runtime。参考 Zed 的 External
Agent 连接边界，共享 Pool 限定在一个 Canonical Project 内，并以 Provider、Canonical Agent
Home 与 Adapter Launch Identity 为 Key。每个 Session 仍独立拥有 Workspace、Provider
Session ID、配置、权限、身份、MCP Scope、Active Turn 与 Recovery State；在一个 Runtime
Host 内，一个 Provider Session 在全部 Project Pool 中最多只有一个 Live Owner。关闭或删除
一个 Session 不能停止同 Pool 的无关 Session。共享 Runtime 失败时必须对账全部受影响
Session，且绝不重放结果不明确的 Prompt。
Codex、Claude、OpenCode、Qoder 与 Qwen 都使用该 Connection 边界。与 Zed 一致，只有
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

## Transcript 协议

Backend 把 History Replay 与 Live ACP Update 归约成一条有序、Provider-neutral Transcript。
Text、Reasoning、Tool、Patch、Plan、Terminal、Media、Resource、Permission 与 Child Session
保持结构化；UI 不得先压平成普通文字再反向解析。

Browser Delivery 使用严格 Checkpoint + Delta 契约：

- Checkpoint 标识精确 Agent、Provider Session、Runtime Epoch 与 Transcript Revision；
- Delta 只能应用到相同 Epoch 和精确前序 Revision；
- 发现缺口、Identity 变化或 Reset 时必须请求 Replacement Checkpoint；
- 其它 Agent 或旧 Revision 的迟到响应不能抢回当前 Chat。

每个 Browser Connection 都会显式声明当前可见 Agent。ACP Revision Notification 只投递给
Interest 匹配的 Connection。切换 Focus 或重连时，会把当前绝对 Revision 作为 Agent-scoped
Checkpoint 发送。慢连接只保留一个 Pending Checkpoint Marker，并在 Transport Buffer 排空后
恢复最新 Revision；不会按每次 Provider Update 累积一条待发送通知。

Provider Replay 是权威来源。Local Checkpoint 可以加速投影并保留 Reset Fence，但除非 Provider
能证明 Freshness，否则不能替代完整 Load。结果不确定的 Prompt 会让 Checkpoint 保持 Dirty。

打开 Chat 时应立即显示 Shell；存在合法 Prepared Checkpoint 时，首份稳定 Transcript 应在
数十毫秒内可见。Prepare 只在 Backend 中根据明确 Interest Signal、并等待系统稳定后执行。
它可以取消，受 Revision Fence 保护，并对 Entry 数、单响应大小、总 Cache 与 Active Work
分别设界。失败或淘汰时回退到同一条权威 On-demand Read。

首份稳定 ACP Transcript 只包含最新 5 个 Turn。用户向上阅读时，再按有界批次加载更早的
Turn，避免打开长 Chat 时把全部 Markdown 与工具历史放入首屏渲染路径。

Browser 只为当前可见 Chat 保留重量级 Transcript Tree。Inactive Chat 只保存轻量导航 Anchor，
再次进入时从 Backend Checkpoint 读取。阅读位置绑定稳定 Turn 或 Process Item，而不只记录
Pixel，因此重启与分页后可以恢复上下文，同时避免大量 Frontend Memory 占用。

## 生命周期与恢复

有业务意义的 Session 状态包括 Connecting、Idle、Working、Waiting for User、Interrupting、
Recoverable Error 与 Terminal Failure。Idle 是普通 Live State；Session 会一直保持 Live，
直到用户归档、系统替换或清理它，或精确证明 Runtime 已失败。

Adapter 或 Host 异常退出必须进入明确恢复或失败。恢复需要证明旧进程 Ownership，恢复同一
Provider Session 与私有 Scope，重新加载权威 History，并保留显式 Config Override。断线时
正在执行的 Turn 结束为失败或不确定，绝不能静默重放。

ACP Runtime Host 无法启动或重连时，只把受影响 Chat Session 标记为不可用，不得阻塞
Server Ready、Native Terminal Recovery、Files 或 Plugins。一个 Runtime Family 的恢复不能
成为无关 Runtime Family 的全局 Lifecycle Barrier。

Chat/Terminal 切换是真实 Runtime Replacement；只有证明可恢复时才保留同一 Provider
Conversation。Turn 活跃时拒绝切换。目标 Runtime 启动失败时，Farming 恢复原 Runtime 并
报告切换失败。

Conversation Fork 只有在 Adapter Contract 与 Live Capability 都支持时才可用。Source
Revision、Child Identity、Ownership 与 Cleanup Responsibility 必须精确；Child Durable 前
失败时必须显式报告，不能静默创建另一个 Fork。

## 展示契约

Chat 展示有序对话、当前 Turn 的一条紧凑 Live Activity，以及可逆的结构化证据。已完成的
Reasoning 与 Tool Detail 不应在默认阅读面上形成重叠摘要。Disclosure Control 保留稳定布局
槽位，只在 Hover 或 Keyboard Focus 时视觉浮现。

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
Reasoning 展开内容不再重复已经作为折叠标题的首行。

最新 Live Answer 的首份权威正文直接完整挂载。仅当用户仍停留在该 Agent 时，后续保持前缀
关系的 Revision 才按有界阅读节奏释放新增后缀。Navigation、Pane 非活动、Turn 完成、
Recovery、Reduced Motion、页面隐藏或非前缀修正都立即显示当前权威全文，不重播缓冲正文。

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
