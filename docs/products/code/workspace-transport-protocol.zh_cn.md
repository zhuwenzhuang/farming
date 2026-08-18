# Workspace 传输协议

> English version: [workspace-transport-protocol.md](./workspace-transport-protocol.md)

状态：已实现。Browser 产品路径使用共享 WebSocket 承载 Workspace File 与 Language
Server 控制请求；HTTP 只保留下文定义的有界 Data Plane 场景。

本文定义 Project Files、Git 查看、文件监听与托管 Language Server 请求如何共用 Farming
现有主 WebSocket。它补充 [Project Files 设计](./project-files-section-design.zh_cn.md)与
[Workspace File 状态模型](./workspace-file-state-model.zh_cn.md)。本文是传输契约，不要求
实现通用 RPC 框架或通用状态机类库。

## 决策

Farming 使用已经完成协议协商的主 `/ws`，作为 Workspace 操作唯一的交互控制连接，
不再创建 Files 或 Language Server 专用 WebSocket。

该连接复用相互独立、可取消、Project-scoped 的请求、结果和事件。普通源码文件与有界
结构化结果可以内联传输；大块字节继续使用已认证 HTTP，避免一个大 Frame 在 WebSocket
有序字节流中阻塞 Terminal 输出、ACP 事件或交互式 Workspace 请求。

共用一条连接不表示 Workspace 操作串行执行。Transport 只负责关联请求，Backend 仍并发
执行相互独立且有界的操作。

## 目标与非目标

本设计必须：

- 从普通文件导航和 Language Server 工作中移除 Browser HTTP 连接准入与反复建连成本；
- 保留一套已认证、版本化的 Browser Protocol 和一套重连生命周期；
- 显式处理取消、迟到结果、超时、响应丢失与 Mutation 结果不确定；
- 保持 Filesystem、Workspace File Model、Editor Group 与 Explorer 的所有权边界；
- 防止后台 Git、Search 或 Language Server 工作饿死文件打开、Terminal 交互或 ACP 进度；
- 保证每个请求、响应、缓存、队列和 Payload 都有界。

本设计不：

- 把 WebSocket 变成大文件或媒体传输通道；
- 用新 IDE Backend 替代 `WorkspaceFileService`、Git、`rg`、Monaco 或 Managed Language Server；
- 把取消当作正确性机制；
- 让独立 Filesystem Writer 与 Farming 组成事务；
- 为 WebSocket 控制请求增加 HTTP 兼容回退。

## 所有权与分层

```text
Explorer / Editor / Git Panels / Monaco Providers
                       |
                       v
       Workspace Request Clients 与 File Models
       - 当前 Intent 与 Model 准入
       - 同 Resource Resolve 共享
       - 有界 Retained Snapshot
                       |
                       v
         主 WebSocket Request Multiplexer (/ws)
       - Request 关联与取消
       - 重连分类
       - 有界 Queue 与 Result 分发
                       |
                       v
           Project-scoped Backend Dispatcher
       - Schema 与 Access 校验
       - 公平调度与 Cancellation Signal
                       |
          +------------+-------------+
          |                          |
          v                          v
 WorkspaceFileService / Git   Managed Language Server
```

Request Multiplexer 只拥有 Transport Lifecycle，不拥有 Active File、Preview/Pin、目录展开、
Draft、Cache、Filesystem Authority 或 Language Server Lifecycle。

每个 Workspace Resource 使用 `rootId` 加规范化相对路径寻址。`agentId` 不是新的文件身份，
Workspace Protocol 不使用它。Backend 每次请求都通过 Root Registry 把 `rootId` 解析为
Canonical 且已授权的 Workspace；Persisted Client 升级期间，旧 Agent Reference 只作为边界
兼容输入保留。

## 传输边界

| 操作 | 主 `/ws` | HTTP Data Plane |
| --- | --- | --- |
| Workspace Root Inventory | 现有权威 State Snapshot/Delta | 不保留 Files Endpoint |
| Directory Tree 与普通文件 Metadata/Read | Request/Result | 仅 Oversized 或 Binary Body |
| Save、Create、Rename、Move、Delete | Payload 可内联时使用 Request/Result | 仅 Oversized Upload Body |
| Search | 有界 Match 的 Request/Result | 无 |
| Changes、Branch Inventory、Worktrees、History、Blame、Line Changes | 分页或截断的 Request/Result | 无 |
| Branch Switch | 带 Operation Identity 与 Version Fence 的 Request/Result | 无 |
| Exact File Watch 注册与 Invalidation | Command/Ready/Event | 无 |
| Language Server Capability 与 Semantic Request | Request/Result/Cancel | 无 |
| Language Server Refresh | 现有有序 Event | 无 |
| Static HTML Preview Session Create/Delete | Request/Result | Preview Document 与 Asset |
| Image、PDF、Audio、Binary、Archive | Metadata/Request Result | 供 Browser-native Viewer 使用的有界 Bytes |

HTTP Transfer Response 仍使用相同 `rootId`、Path、Access Mode 与 Content Version 做授权。
Viewer 仅仅因为 Browser Element 需要 URL，不能形成第二条 Workspace Authorization Path。

最终 Browser 产品路径不能为 WebSocket 控制操作保留自动 HTTP Fallback。主 WS 断开是
明确的连接失败，不是打开平行 HTTP 控制流量的信号。

## 协议形状

Workspace Files 与 Language Server 保持不同的强类型 Domain，但共用一个 Request Broker
和一条物理连接。这样可以维持精确的 Schema 与 Authorization，而不是引入能调用任意
Backend 函数的通用 `method` String。

代表性 Envelope：

```ts
type WorkspaceRequestMessage = {
  type: 'workspace-request'
  requestId: string
  request: WorkspaceReadRequest | WorkspaceMutationRequest | WorkspaceGitRequest
}

type LanguageServerRequestMessage = {
  type: 'language-server-request'
  requestId: string
  request: ManagedLanguageServerRequest
}

type WorkspaceCancelMessage = {
  type: 'workspace-cancel'
  requestId: string
}

type WorkspaceResultMessage = {
  type: 'workspace-result'
  requestId: string
  ok: boolean
  result?: WorkspaceResult
  error?: WorkspaceProtocolError
}

type LanguageServerResultMessage = {
  type: 'language-server-result'
  requestId: string
  ok: boolean
  result?: unknown
  supported?: boolean
  error?: WorkspaceProtocolError
}
```

`WorkspaceRequest` 是 Discriminated Union，每个 Operation 都有精确 Payload 与 Result
Schema。共享协议 Validator 在 Dispatch 前拒绝未知 Operation、存在安全歧义的未知字段、
非法路径、无界 Array/String，以及超过 Inline Limit 的 Payload。

Request ID 在一条 Browser Connection 内唯一。只有相同 Request ID 与 Domain 的 Pending
Record 可以接收结果。未知、重复、已取消或已完成的 Result 会被忽略并计数，绝不能进入
Editor 或 Explorer Owner。

Protocol Error 使用稳定 Code，例如 `NOT_FOUND`、`FORBIDDEN`、`CONFLICT`、`TOO_LARGE`、
`TIMEOUT`、`CANCELLED`、`BUSY`、`UNAVAILABLE` 与 `INTERNAL`；Message 保留可操作的人类文本。
当 Backend 无法证明 Mutation 是否已经 Commit 时，Error 还必须声明 `uncertain: true`。

## 请求生命周期

Browser Request 可以处于 Locally Queued、Sent、Settled、Cancelled、Disconnected 或
Uncertain。这些是推理状态，实现可以继续使用普通 Record、Promise 与 Abort Listener。

| 当前状态 | 触发 | 必须产生的结果 |
| --- | --- | --- |
| Locally Queued | Compatible Protocol Hello | 仅在仍有 Live Consumer 时发送一次。 |
| Locally Queued | Cancellation | 本地 Reject，不发送。 |
| Sent Read | Result | 只完成对应 Pending Request 一次。 |
| Sent Read | Cancellation | 本地 Reject，并 Best-effort 发送 `workspace-cancel`。 |
| Sent Read | Disconnect | 标为 Unsent；Compatible Reconnect 后可用相同 Request ID 重发。 |
| Sent Mutation | Result | 完成一次，并保留 Conflict 或 Uncertain 语义。 |
| Sent Mutation | Cancellation 或 Disconnect | 标为 Uncertain，绝不自动重放。 |
| 任意 Settled State | Late Result | 忽略，不改变 UI 或 Model State。 |

Read Replay 安全是因为它不修改 Filesystem 或 Process State。复用 Request ID 不表示允许
Mutation Replay。Save、Create、Rename、Move、Delete、Preview Session Mutation 与 Branch
Switch 在结果不明确时，必须从权威 File、Parent Directory、Preview Inventory 或 Git State
对账。只有完成 Reconciliation 后，Explicit Retry 才按照该 Mutation Owner 的 Operation
Identity 规则开始。

Cancellation 释放一个 Consumer。同 Resource Resolve 被多个 File-open Intent 共享时，
只有最后一个 Live Consumer 消失才发送 Transport Cancel。Backend Cancellation 是 Best
Effort：不支持取消的 Filesystem/Git 工作可以完成，但其结果仍受 Request Ownership 与
Latest File-open Intent 限制。

## Server Dispatch 与调度

WebSocket Message Handler 只执行 Validate 与 Schedule；不能等待一个长 Filesystem、Git
或 Language Server 调用后才接收下一条消息。每个 In-flight Request 拥有 AbortController、
Deadline、Operation Classification 与有界 Result Budget。Connection Close 会取消所有
Cancel-safe 工作并释放其 Watch Registration。

Workspace Work 至少分为两个 Scheduling Lane：

- **Interactive**：Tree Expansion、File Resolve、Explicit Reload、Save 与直接 Semantic Navigation；
- **Background**：Search、Git Status、History、Blame、Preview、自动 Semantic Tokens、Inlay
  Hints、Symbols 与 Watch-triggered Revalidation。

Background Work 使用独立并发上限，不能占满所有 Workspace Execution Slot；至少保留一个
Interactive Slot。Limit 同时按 Connection 与 Global 生效，避免一个 Browser 制造无界 Server
工作。同 Resource Read 由 Workspace File Model 合并；Transport Scheduler 不建立第二份 Cache。

Terminal Input 与已经到达的 Protocol Message 继续同步接收。Workspace 调度不得延迟其
Dispatch。CPU-heavy 或 Blocking Subprocess Operation 继续位于现有有界 Async Service 后面。

## Payload 与 Backpressure

WebSocket 有序传输意味着已经发出的 Large Frame 无法被 Terminal 或 ACP Frame 超越，因此
仅有应用优先级不够，Inline Payload Size 必须成为协议边界。

Protocol Hello 声明实际生效的 Workspace Inline Payload Limit。初始生产值由 Remote 与
Mobile 实测决定，同时为每条序列化 Workspace Message 设置 1 MiB Hard Ceiling。超过实际
Limit 的 Source Read、Save、Diff 或 Structured Result 不得作为单个 Frame 进入主 WS。

超过 Inline Boundary 的 Read 返回有界 Metadata 与已认证 HTTP Transfer Descriptor，其中
包含 Content Version。HTTP Response 受 Workspace File Limit 约束，并在发送 Bytes 前拒绝
Stale Version。超过 Inline Boundary 的 Save 使用 HTTP Upload Path，但保留相同 Expected
Content Version 与 Mutation Reconciliation 契约。Binary 与 Preview Asset 使用 HTTP，因为
Browser-native Viewer 需要 Resource URL。

Search、History、Symbols、References、Diagnostics 等结构化集合使用分页、数量上限或显式
Truncation，不通过静默创建 Bulk Transfer 规避边界。

Server 不能因为 `bufferedAmount` 过高就静默丢弃 RPC Result。它应停止接收 Background Work、
维持有界 Pending-result Budget，并在制造无界内存前对新 Workspace Request 显式返回 `BUSY`。
持续 Transport Backpressure 变成可见连接失败，并进入正常 Reconnect 流程。

## File Read、Model 与 Cache

把读取迁入 WebSocket 不改变 Workspace File State Model：

- 选择已打开 Model 不产生 Transport Read；
- 同一 Canonical Resource 的重复首次打开共享一次 Resolve；
- 返回 Retained Watched Clean Model 时立即 Paint 且不重复读取；Exact Watch Invalidation
  会移除该 Snapshot，首次 Watch Ready 与重连负责有界 Reconciliation；
- 更新的不同文件 Intent 即使未能取消 Backend 工作，也会撤销旧 UI Commit Lease；
- Pinned Tab 不能被后续选择降级为 Preview；
- Transport Result 不能展开 Agent Group、移动 Focus 或重放一次性 Reveal Request。

Successful Read 返回 Content Revision（例如现有 SHA-1）及 Filesystem Metadata。Cache 使用
Canonical `rootId` 与 Normalized Path 作为 Key，不能跨 Workspace Ownership Boundary。
File Event 只是 Invalidation Hint，不包含文件内容，也不能证明 Cached Version 仍是最新。

## Watch 与重连

Watch Registration 从 Agent Identity 迁移到 Workspace Identity。每条 Connection 按 `rootId`
声明自己当前拥有的 Exact Normalized Path。Backend 为每个 Workspace 维护一个增量更新的
Exact-path Watcher，并按 Connection 分发 Ready/Error/Change Event。

Watch Readiness 包含已接受的 Path Set 或其 Revision。Successful Read 后首次 Watch Ready
不能立即被当作 File Change。Reconnect 后，Browser 在 Protocol Hello 后恢复 Exact Watch
Set，并权威 Revalidate 所有打开的 Watched Resource，因为断线期间可能丢失 Event。Event
Burst 按 Canonical Resource 合并。

Directory Expansion 不安装 Recursive Project Watcher。Directory Snapshot 仅在 Explicit
Navigation、已证明的 Mutation，或 Explorer 拥有的有界 Targeted Invalidation 后刷新。

## Mutation

每个 Mutation 携带精确 `rootId`、规范化 Path Identity、Expected Object/Content Version，
以及 Service 支持 Deduplication 时的有界 Operation Identity。Backend 按 Operation 校验权限；
Read 与 Write 共用一个 Envelope 并不意味着 Read-only Share 可写。

成功后由既有 Owner 刷新或失效相关 Directory Snapshot、Retained File Model、Working Copy、
Tab、Git Projection 与 Watch State。Conflict 保留 Draft 并返回权威 Version Evidence。Timeout、
Disconnect 或 Response Loss 永远不能变成 Automatic Retry。

Branch Switch 继续与 Project Operation 串行化，并保留现有 Branch/HEAD Fence 与
Reconciliation。迁入 WebSocket 不得削弱这些 Guard。

## Language Server

Language Server Capability 与 Semantic Request 共用主连接和 Request Broker，但保留独立
Typed Protocol 与 Backend Dispatcher。Dispatcher 解析 `rootId`、校验 Result Location、应用
现有 Saved-file 与 Result-size 规则，然后委托 Managed Language Server Service。

当对应 Language Server Request 已无 Consumer 时，Monaco Cancellation 发送
`workspace-cancel`。被替代的自动请求不能一直占用 Browser HTTP Connection 或 Workspace
Background Slot 直到 Language Server Deadline。Cancellation 仍是 Best Effort；Editor Model、
Saved Revision、Binding 与 Provider-refresh Revision 继续阻止所有迟到 Semantic Result。

Language Server Refresh 继续作为同一 WS 上有序、Project-scoped 的 Server Event，不改为 Polling。

## Access 与安全

- Authentication 与 Owner/Read-only Mode 来自协商后的 WebSocket。
- 每个请求都通过当前 Root Registry 解析 `rootId`；Browser Path 不能选择任意 Server Filesystem Root。
- Read-only Connection 可以执行 Read、Git Inspection、Watch、Preview Viewing 与 Language
  Server Request，但不能执行 Filesystem 或 Branch Mutation。
- Exact External-file Access 继续对 Read-only Share 禁用，并保留明确的 Local Authorization Boundary。
- Symlink Escape Check、Path Normalization、Git-safe Argument、Preview CSP 与 Language Server
  Result Filtering 继续留在各自 Service Owner 中。
- Log 与 Metric 可包含 Operation、Duration、Byte Count、Queue Time、Outcome 与 Cancellation
  Reason，但不得包含文件内容或完整 Path。

## 迁移计划

1. 增加 Connection-owned Request Broker 与 Typed Protocol Validation，不修改
   `WorkspaceFileService` 或 Managed Language Server Service。
2. 先迁移关键 Read Path：Tree、普通 File Read、Watch Identity 与 Language Server
   Request/Cancel；在迁移更多操作前证明随机快速切换。
3. 迁移有界 Search 与 Git Inspection Request，保留现有 Paging、Timeout 与 Truncation。
4. 迁移 Save、Create、Rename、Move、Delete、Preview Control 与 Branch Switch；移除其 HTTP
   Control Path 前先增加 Mutation Reconciliation Test。
5. 只保留本文定义的 Raw/Oversized/Binary Transfer 与 Preview Asset HTTP Data-plane Route；
   删除无用 Control Endpoint 以及会保留第二条产品路径的测试。

开发过程中，两种 Transport 可以存在于显式 Test-only Migration Seam。发布的 Browser/Backend
Pair 根据 Protocol Version 使用一条 Control Path，不能逐 Operation 静默 Fallback。

## 验证与可观测性

Protocol 与 Service Test 必须覆盖：

- Schema 拒绝、Access Mode、Root Resolution、Path Escape、Result Correlation、Duplicate Result
  与 Unknown Cancellation；
- Same-resource Request Sharing，以及取消一个或全部 Consumer；
- 跨多个 Project 的 Slow Old File 后连续打开 Fast New File；
- 随机 Cold/Warm 切换足够多的文件、目录与 Semantic Request，以压满 Background Lane；
- Pinned Tab 在 Result 后仍为 Pinned，手动收起的 Agent Group 在 Result、Watch Event 与
  Inventory Update 后仍保持收起；
- Request Reordering、Send 前取消、Send 后取消、Reconnect、Server Restart 与 Late Completion；
- Clean/Dirty/Saving Conflict Transition，以及不自动重放的 Uncertain Mutation Reconciliation；
- Inline Boundary Read/Save、Bounded HTTP Transfer Handoff、Truncated Structured
  Result 与 Binary Viewer；
- Slow Client Backpressure 下 Terminal Input/Output 与 ACP Progress 仍然响应；
- Language Server Timeout、Cancellation、Refresh、Malformed/Oversized Result 与 Saved-model Fence；
- Reconnect 后恢复 Exact Watch，且没有 Recursive Project Watcher；
- 最终 Browser Acceptance Trace 中不存在普通 Files 或 Language Server HTTP Control Request。

Measured Diagnostic 分别记录 Queue Wait、Service Execution、Serialization、Socket Backlog、
Model Admission 与 Editor Paint。Seeded 类人 Browser Test 保存 Action Log、Request Trace、Latency
Summary 与 Final Screenshot，避免断言通过却掩盖肉眼可见的 Editor 卡顿。

## 被否决的方案

- **第二条 Files WebSocket**：重复 Authentication、Liveness、Reconnect 与 Protocol Version
  State，却无法消除 TCP Head-of-line Blocking。
- **HTTP 加激进 Abort**：可以减少无用工作，但不能消除 Browser Connection Admission、反复
  Setup 与割裂的 Reconnect Semantic。
- **所有 Byte 都走主 WS**：一个大 Ordered Frame 会阻塞 Terminal、ACP、Watch 与 Semantic Result。
- **一个全局 Files 状态机**：合并 Transport、Model、Explorer 与 Editor Ownership，制造的非法
  组合比解决的更多。
- **自动 HTTP Fallback**：形成两条产品路径，使失败与性能取决于偶然命中的 Transport。
