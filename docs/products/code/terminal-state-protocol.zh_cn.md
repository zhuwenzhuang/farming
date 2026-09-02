# Terminal State Protocol

> English version: [terminal-state-protocol.md](./terminal-state-protocol.md)

Farming Code 与 Farming CRT 共用一套带 Checkpoint 的持久 Terminal Protocol。

## Ownership Model

Native PTY Host 拥有 Live PTY、有序 Byte Stream、Terminal Reducer、Screen State、Process
Identity 与 Restart Continuity。Farming Server 控制 Lifecycle 并发布状态；Browser Renderer
只 Attach 到该状态，不拥有 Terminal Truth。

一次 PTY Lifetime 对应一个 Runtime Epoch。Epoch 内的有序 Output 与 State Revision 标识一份
权威 Cut；它们只是 Transport Cursor，不是第二套 Agent Lifecycle。

## Provider Activity 与 Attention

对于持久运行的 Coding CLI，Process 存活不等于 Turn 正在执行。Provider Terminal Observer 从
Provider 当前的权威 Screen Projection 推导 `busy`、`idle` 或 `unknown`。`busy` 到 `idle` 的
转换可以立即完成 Attention；持续静默时间不能作为完成证据。

Qwen Code 使用自身渲染出来的 Streaming-state Contract。Responding Screen 会包含 Loading Row
或带 `Ctrl+Q` 的 Queue Footer；当这些 Marker 从当前 Ink Screen 中移除时，说明 Qwen 已离开
Responding，进入 Idle 或需要用户输入的状态。Farming 直接消费该 Output Transition。Parent Turn
仍处于 Responding 时收到的 Terminal Notification 先保持 Pending，因为 Child Work 可能早于
Parent Turn 结束发出 Notification。Screen Evidence 缺失或有歧义时保持 `unknown`，不启动基于
时间的 Fallback。

Pi 的默认 TUI 只有在 Current Screen 同时包含内置 Braille Activity Indicator，以及可识别的
Working、Retry、Compaction 或 Branch-summary Status 时才是 `busy`；该 Current-screen Marker
移除后回到 `idle`。Farming 不猜测 Extension 自定义的 Status Text；有歧义的 Custom Output
保持 `unknown`。

## Checkpoint 与 Delta

Terminal Checkpoint 包含 Runtime Epoch、State Revision、Output Sequence、Serialized Screen、
Dimensions，以及继续交互需要的 Terminal Mode。Browser 只在 Attach、Reconnect、Page Resume
或发现 Gap 时请求当前 Checkpoint，不持续轮询。

Checkpoint 安装完成后才能继续应用 Live Output。Browser 丢弃已被 Checkpoint 覆盖的 Output；
发现 Sequence Gap 或 Epoch 变化时请求新 Checkpoint。

Checkpoint Read 通过完成协议协商的 Main WebSocket 作为 Multiplexed RPC 传输。Browser 发送带
Request ID 与精确 Agent Identity 的 `terminal-checkpoint-request`，Server 在同一连接返回匹配的
`terminal-checkpoint-result`。Browser 不再存在 HTTP Checkpoint Path 或 Compatibility Fallback。

连接断开后，未完成请求恢复为 Unsent。下一次 Compatible Protocol Hello 完成后，Browser 可以用
相同 Request ID 重发这个 Read-only Request。该重放规则只适用于 Checkpoint Read，不能推导出
Terminal Input 或 Lifecycle Mutation 可以安全重放。Cancellation 与 Timeout 仍然有界，但 HTTP
Connection Admission 与 Browser HTTP/1.1 Queue 不再参与 Terminal Attachment。Background
Attention 变化不会推测性读取 Checkpoint；只有 Attachment 或真实 Recovery Trigger 才请求所需的
权威 Cut。

已经排入 Renderer Queue 的 Stale Checkpoint 可以按顺序排空，但存在更新 Attachment 或 Recovery
Generation 后，它的 Completion 不能提交。Replacement Checkpoint 必须始终能推进到可见权威状态。
Renderer 处于 Detached 时收到的 Replacement Transition 不能静默丢弃：它必须推进 Attachment
Recovery Target，并将该 Record 标记为下一次可见 Attach 前需要重新读取权威 Checkpoint。

完整 Checkpoint 安装期间隐藏旧 Screen。用户只会看到上一个已证明 Screen、有界 Recovery
Status 或新提交 Screen，不会观看历史重绘逐步回放。

## Browser Attachment

Terminal Session Pool 为每个 Agent 保存一份 Browser-side Record。Attachment Identity 是 Agent
与 Mount。普通 Component Rerender 和 Callback 变化不能 Detach Terminal 或启动 Recovery。

Pool 是 Composition Root 与稳定 Public Facade，不拥有 Record 中的每一项状态。它负责精确 Key
的 Registry Admission、Renderer Bootstrap、Attach/Detach、Parking 与 Dispose 编排。
Replication Owner 统一拥有 Checkpoint Snapshot、Request/Retry 状态、有序 Renderer Write
Completion、Live Transition Admission、Reconnect/Page-resume Recovery 及其 Diagnostic
Projection。Interaction Owner 统一拥有 Selection、Context Menu、Clipboard 与 Key Routing、
IME Overlay、Touch Gesture、Link Interaction 和精确 DOM Listener Lifecycle。两者都消费
Attachment Coordinator 的唯一 Operation Identity，不维护平行 Generation。

Attachment Lease 处于 Detached、Attached 或 Release-pending。同一 Agent 与 Mount 重新获取时
取消 Pending Release。Stale Lease 不能释放更新 Attachment；Agent 或 Mount 真正变化时先释放
旧 Owner，再 Attach 新 Owner。

Provider Capability `terminalReadingAnchor` 声明 Terminal 阅读位置是否属于 Native
Scrollback。Provider 自己拥有 Full-screen 或 Virtualized Viewport 时，该值为 False，Pool
不会持久化 Terminal Reading Anchor，也不会按内容匹配恢复它。Checkpoint Recovery、
Attachment、Resize 与普通 Follow-output 行为仍保持 Provider-neutral。

Code 与 CRT 共用同一 Protocol Contract 与 Recovery Semantics。两套界面可以适配不同
Layout 与 Renderer Integration，但不能各自维护第二套 Ordering 或 Checkpoint State Machine。

## Input 与 Resize

可选 `performanceId` 仅用于关联不含输入正文的
[交互性能诊断](../../development/interaction-performance.zh_cn.md)，不构成确认、重放键，
也不能证明后续输出是该输入的回显；输入准入与传递语义不变。

Terminal Input 是 Renderer Raw Input Stream，只写入 PTY 一次。Farming 不增加 Speculative Replay
或 Input ACK。多个已授权 Viewer 可以输入同一 PTY；Backend 按到达顺序串行写入。

结果无法确认的 Terminal Write 属于不确定结果，绝不会被 Replay。此类写入会激活对应 Runtime 的
Input Fence：在 Fence 之前 Admission 的 User Input、Queued Input、System Control Traffic 与
Interrupt 保持被拒绝状态，Fence Active 期间也不允许新的 Input Admission。只有携带该 Terminal
精确当前 Runtime Epoch 应答的显式 Terminal Checkpoint Request 才能 Reconcile Fence，并且只对
该 Reconcile 之后 Admission 的 Input 生效。Terminal Runtime 替换优先于旧 Fence；在旧 Runtime
下 Admission 的 Input 按其捕获的 Epoch 被拒绝。被拒绝的 Raw WebSocket Input 通过受协议验证的
可见错误提示给写入方 Client，而不是被静默丢弃。

IME Composition 在 Terminal Input Surface 内完整结束后再发送 Committed Text。Fallback 处理
不能重复发送普通 ASCII Input。

Touch Gesture State 归对应 Terminal Host 的 Interaction Owner。该 Owner 精确安装和移除
Pointer Listener，并委托拥有 Long-press、Momentum、Edge Feedback、Timer、Animation Frame
及其 Dispose 的 Gesture State Machine。

Resize 是有序 Terminal Transition。Layout Churn 合并为最新完整 Geometry，同时不破坏 Output
顺序。Browser 应用已提交 Remote Resize 时不回传。Recovery 不能自动抢回某个旧 Viewer 的
Geometry，因为可能存在其它 Active Viewer。

Attachment Coordinator 仍是 Protocol Generation、Operation Revision、State Revision 与
Transition Commit 的 Owner。Browser Resize-effect Controller 只拥有 Observer、Fit、Redraw、
Delivery 与 Local-renderer Effect。每个 Scheduled Effect 都捕获精确 Attachment Operation 与
自身 Effect Revision。任意时刻最多只有一个 Resize Mutation In-flight，并且只保留最新完整的
Pending Geometry。

Resize Delivery Timeout 表示 Mutation Outcome 不确定。Browser 进入 Checkpoint Recovery，不能
直接发送 Pending Geometry。权威 Checkpoint 建立新的 Attachment Cut 后，只有 Recovery 明确要求
时，Controller 才可以发送一次当前可见 Geometry。来自旧 Attachment 或 Effect Revision 的 Late
Acknowledgement、Animation Frame 或 Timer 不能完成或修改新的 Cut。

## Output、Backpressure 与 Rendering

PTY Host 只在 Reducer 提交后发布 Output。Reducer Backlog 可以暂停 PTY Read。慢 Browser
Connection 相互隔离，一个 Viewer 不能为其它 Viewer 积累无界 Debt。

持续 Output 可以为 Rendering Batch，但每个 Transition 仍保持有序且可检测 Gap。Resize Redraw
形成 Presentation Boundary，让 Full-screen TUI 稳定后再显示新 Cut。

权威 Terminal Reducer 与 Code、CRT Renderer 保留相同的有界 Scrollback 上限。Checkpoint
传输先加载较小的最近窗口；当用户滚动到已加载历史的顶部附近时，再按有界档位逐步扩大，直至权威
上限。每次扩展都在已证明的 Revision 上替换序列化 Terminal 状态，并恢复用户的逻辑阅读锚点；
不得直接拼接原始 ANSI 文本，也不得另建一套 Output Ordering 路径。每个 Surface 同时最多只有一个
扩展请求，连续滚动只提升目标窗口。

服务端按 Agent 使用有界的一秒时间桶统计终端输出速率。每个时间桶累计输出字节数和输出片段数，
只保留最近五分钟。用量速率和注意力评分读取这些时间桶，不再为每个输出片段保存并扫描一个独立
对象。时间窗口边界最多产生一个时间桶的估算误差；终端输出顺序和实际字节传输仍保持精确，不依赖
这项诊断统计。

xterm.js WebGL 是 Code 与 CRT 唯一受支持的 Product Renderer。Renderer Failure 显式展示；
Retry 重建同一支持路径。Diagnostic Renderer 不能成为静默 Production Fallback。

## Clickable Output

Terminal Link 分层识别 Explicit Hyperlink、HTTP(S) URL、Workspace File Location、Compiler-style
Location 与有界 Multiline Pattern。词法识别不等于授权：每个 File Candidate 必须先根据捕获的
Workspace 或显式 Read-only File Boundary 解析，无法解析时保持普通 Text。

检测按 Input Length、Candidate Count 与 Logical-line Scope 有界。File Identity 与 Location
保持精确，不跨显式换行猜测。

异步 Link Resolution 同时捕获完整 Attachment Operation 和当前 Handler Revision。同一个
Attachment 内的 Checkpoint 或 Recovery Operation 前进后，旧解析不能再装饰或打开目标。

## Title 与 Activity Projection

Terminal Agent Title 通过带鉴权的 Agent Control Path 发布，不从 Terminal Prose 推断。Runtime
Replacement 会轮换 Title Authority；User Rename 最高优先；Title Failure 不得阻塞 Terminal Input。

Focused Terminal 的 Output 与权威 Screen State 优先于低频 Activity 或 Preview Metadata。选择
Existing Agent 只是本地 View Change，不能触发 Full Agent-state Refresh。

通用 Terminal State Machine 负责 Lifecycle 与 Shell 的优先级；Coding Agent 的 Screen
Evidence、Nested-process Title、Input Readiness 与 Activity Parsing 由 Provider Terminal
Observer Registry 提供。通用 Terminal 代码不能通过判断 Provider Name 来选择 Parser；新增或
修改 Provider Parser 必须作为 Observer Boundary 变更，并由聚焦的 Parser 与 Runtime-observation
Test 验证。

## Recovery 与 Failure

兼容 Server Restart 会重连 Live PTY Host。不兼容 Host Replacement 在可能时先保留 Final
Checkpoint。PTY Host 意外丢失属于 Process Loss，不能伪装成成功 Replay。

Transport Failure 使用有界 Backoff；连续三次 Checkpoint Request 失败后进入可见 Terminal
Error。连续违反 Checkpoint Invariant 时同样进入可见 Terminal Error，不能永久循环。用户点击
Retry 会启动新一代 Recovery，并重新读取权威 Checkpoint。结果不确定的 Input 或 Lifecycle
Mutation 先根据权威 Terminal 与 Process State 对账，绝不盲目重放。

## 验收标准

验证必须覆盖：Attach、Detach、Hidden-page Resume、Reconnect、Restart、Epoch Change、Sequence
Gap、Stale Checkpoint Completion、Multi-viewer、IME、Direct Input、Resize Churn、Full-screen TUI
Redraw、Mouse Mode、Clickable Location、Slow Connection、Renderer Failure 与精确 Process Cleanup。
还必须覆盖至少六个 Agent 时，展开折叠列表并选择初始隐藏 Agent，同时存在无关 Background HTTP
Read 的场景；存在对应交互的 Code 与 CRT 都要满足同等验收标准。
