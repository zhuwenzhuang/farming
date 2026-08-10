# Farming CRT Layout

> English version: [base_layout.md](./base_layout.md)

Farming CRT 是连接同一套 Backend Agent 与 Session 的桌面端、键盘优先控制室。Farming Code
继续作为受支持的移动端界面。

## 区域

CRT 有三个常驻区域：

- **Top Bar**：紧凑的系统与 Attention 状态；
- **Agent Area**：Live Agent 摘要与已打开 Session；
- **Sidebar**：全局 Action 与 Main Agent 入口。

只有 Live 或 Starting Work 占据 Agent Area。Stopped、Dead 与 Archived Record 进入 History。
没有 Project Agent 存活时，CRT 显示明确的 New Agent 入口，同时不隐藏或重启 Main Agent。

## Attention 与 Layout

Dashboard 帮助用户找到需要关注的工作。Backend 拥有 Agent Lifecycle 与 Activity Fact；CRT
可以据此排序和强调，但不能自行发明 Completion、Zombie 或 Health State。

Card 保持稳定、可读的 Geometry。重要工作可以获得更多面积，但高频 Metadata Update 不能造成
干扰性的 Reorder 或 Overlap。过多 Preview Content 应裁剪或滚动，不能把文字压缩到不可读。
当 Card 无法显示完整的有界 Chat Preview 时，必须优先保留最新消息可见。

## Session

打开的 Chat 与 Terminal 使用和 Farming Code 相同的权威协议。CRT 不实现第二套 ACP Reducer、
Terminal Replay State Machine 或 Agent Lifecycle。

Terminal 是主要 Focus Surface。Structured Chat 保留有序 User、Process 与 Result，不重建 ACP
Entry。Session Header 使用与 Farming Code 相同的 Agent Title Priority。

## Keyboard 与 Dialog

Primary Action 必须支持键盘，并以简洁 Hint 保持可见。Focus、Escape、Confirm、Cancel 与
Return-to-opener 行为在 Dashboard、Search、History、Settings、New Agent 与 Opened Session
之间保持一致。

Dialog 使用紧凑 Header、明确 Focus、Keyboard-confirmable Action 与最少 Nesting。

## 视觉契约

CRT 使用克制的 Monochrome Control-room Style：

- 紧凑信息密度；
- 低视觉噪音与稳定对齐；
- 可读 Monospace Content；
- 不降低可读性的轻量 Scan Effect；
- 不为未实现 Action 保留常驻控件；
- Animation 不能暗示 Backend 未报告的状态。

## 数据与失败边界

Current Capability、Inventory、Usage 与 Health View 都执行 Fresh Authoritative Read，并显示
Loading 与 Failure。Refresh 期间可以保留上一次完整数据，但不能把 Stale Data 当成新的成功结果。

Dashboard Chat Preview 使用与 Farming Code 相同的外部媒体 Transcript Delivery，对并发读取设界，
并在有限时间内重试瞬时读取失败。Preview Failure 仍需显式展示，但一次临时 Transport Interruption
不能永久锁死 Card 状态。

所有 Same-origin Routing 遵循 Server 提供的 Base Path。Routing 缺失、Protocol Incompatibility、
Renderer Failure 与 Session Recovery Failure 都必须显式展示；CRT 不静默切换到未测试 Fallback。

## Billing 控制器

CRT Billing 是一个垂直 Owner（`frontend/skins/crt/billing-controller.ts`），独占所有 Billing
Mutable State、Fetching、Scheduling、Animation 与 Rendering。App Shell 仅接入窄 Lifecycle 与
Navigation Port，不持有重复的 Billing State。

状态模型：

- 单调递增的 **Generation** 计数器为每个异步操作、Timer 与 Animation Frame 设栅栏。Settle 或
  Callback 捕获的 Generation 与当前值不同时，静默丢弃。
- **Summary**（15 s Poll）与 **Live-day Detail**（5 s Poll）各自拥有 AbortController、有界
  Deadline 与 Request Sequence。Deadline Abort 强制释放 Owner，即使 Fetch 忽略 AbortSignal，
  下一次 Scheduled Poll 仍可继续。
- **Top-bar Token Rate**（60 s Poll）拥有 AbortController 与有界 Deadline，使用
  Controller-presence Guard（已有 In-flight 则跳过）而非 Request Sequence。
- 每个 Fetch+JSON 操作拥有一个精确的 **Operation Token**。Deadline 触发且 Generation 仍匹配时，
  先使 Token 失效，再 Abort 并释放 Owner。每一次 Success、Cache Write、Render、Day-followup
  Start、Error 与 Finally Cleanup 都要求当前 Token，因此 Timeout、Leave、Suspend 或 Dispose 之后
  迟到的 Fetch Settle 或迟到的 `response.json()` 完成都是 No-op——即使释放 Owner 并不递增 Request
  Sequence。
- 每个 Deadline 按操作独占：被取代请求的 Finally 不能清除新请求已 Arm 的 Deadline。
- 一次性 Scroll、Draw 与 Navigation Frame 通过 Tracked Helper 注册，在 Leave、Suspend 与 Dispose
  时取消，并额外按 Generation 丢弃；它们不会自我重排。Scope Canvas Frame 在相同切换点显式取消。
- **Day Detail Cache** 在每次 Summary 成功响应后裁剪至权威 Date Set。权威空 Summary 裁剪所有
  缓存条目。

失败与恢复：

- Day Detail 仅对 Network Error、HTTP 408、429 与 5xx 重试，最多四次重试（共五次尝试），
  指数退避。Validation Error 与普通 4xx 对该请求为终态。若 `200` Day-detail Response 在控制器
  已持有该日 Hourly Bins 后暂时省略 Hourly Bins，则视为已证明的暂时回退，保持同一条有界重试路径，
  不清除既有 Hourly Detail。
- 从 Days 切换到 Live Mode 时，Abort 并 Fence 所有待处理的 Days Summary 与 Day-detail Request，
  然后始终启动 Live Summary Load。迟到的 Days Response 不能渲染到 Live View。
- Page Suspend（visibilitychange hidden、pagehide）Abort 所有 In-flight Request 并清除所有
  Timer。Resume 重启 Schedule，并在 Billing View 活跃时执行 Fresh Load。
- 离开 Billing View（Escape、Navigation）停止 Summary/Day Polling、Abort In-flight Billing
  Request 并取消 Animation 与 Tracked Frame。全局 60 s Top-bar Token Rate Poll 独立继续。
- Page/Controller Dispose 递增 Generation、Abort 所有 Request（含 Topbar）并取消所有 Animation
  与 Tracked Frame。Dispose 后 Settle 的过期 In-flight Response 被 Generation Fence 丢弃。

Backend Usage API（`GET /api/usage`、`GET /api/usage/day`）保持为权威数据源。控制器不从
Terminal Text 或 Stale UI Data 重建 Usage Truth。

## 验收标准

验证必须覆盖：Keyboard-only Operation、Empty/Dense Dashboard、Agent Ordering Stability、Code/CRT
Switch、Chat/Terminal Continuity、Search、History、Settings、Capability Failure、Renderer Failure、
Reconnect、Restart，以及 Desktop Viewport 下的大规模 Live Agent Inventory。
