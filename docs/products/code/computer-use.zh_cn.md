# Farming Computer Use（实验性）

> English version: [computer-use.md](./computer-use.md)

用户指南：[Computer Use（实验性）](https://zhuwenzhuang.github.io/farming/cn/experimental/computer-use)。
本文继续作为生命周期、所有权、隔离和验收契约。

Computer Use 是可选的完整 Desktop 能力，包括 Application、Native Dialog、Mouse、Keyboard、
Screenshot 与 Accessibility Information。Browser 继续负责结构化网页与 DOM。

## Desktop Target

- **Local Desktop** 表示 Host 现有图形桌面，需要持续验证的 Native Driver 与单一 Control Owner。
- **Docker 中的桌面（实验性）**为 Agent 提供独立 Linux Desktop；显式准备所需 Container Runtime 后，
  它是当前受支持目标。

Farming 只展示拥有真实、已验证 Runtime 的 Target。前置条件缺失时显式说明，不提供低质量 Fallback。

## Ownership 与生命周期

一个 Agent 最多拥有一台 Docker 中的桌面及其精确 Runtime。不同 Agent 不共享 Desktop
Session、Credential、Profile 或 Private Endpoint。

- Chat/Terminal 与 Permission Replacement 保留 Desktop。
- 停止或归档 Agent 会停止 Runtime，但保留 Resource。
- 删除 Agent 会删除它精确拥有的 Desktop。
- Browser 正在使用 Desktop 时，必须先释放 Lease 才能停止 Desktop。

Chat/Terminal Replacement 会改变 Runtime Agent Identity。Lifecycle Owner 会在 Live Agent
Record 暂时不存在期间 Hold 旧 Agent 的 Browser 与 Computer Resource，并在 Switch 结束前把
这些精确 Resource 转移给已注册的 Replacement。若请求的 Replacement 与原 Runtime 都无法恢复，
则解除 Hold，由普通 Orphan Cleanup 删除这些 Resource。Server Abrupt Loss 后，Farming 使用持久化的
Replacement Lineage 与精确 Project Workspace 恢复未完成的 Ownership Transfer；Lineage 有歧义时
失败封闭，不删除这些 Resource。

破坏性操作前必须验证精确 Ownership。Viewer 通过带鉴权的 Farming Boundary 提供，而不是
暴露公开 Desktop Endpoint。

Resource 拥有唯一的 driver session 身份和 desktop capture scope。在 Resource 的串行 Action
Queue 内，Farming 会在每个 Desktop Session Tool（包括显式 `start_session`）之前幂等刷新这个
确切 Session。调用方提供的 Session 身份和 Capture Scope 都不能替换 Resource 所有的值。
Window 与 AT-SPI Tool 则按照固定 Driver Manifest 以 Cursor-less 方式运行，避免不可变的
Desktop Session Policy 禁用 Window Discovery 或 Accessibility Target Action。其它 Tool 的前置
Refresh 失败时，该 Tool 尚未发送；Farming 会通过 HTTP 和 Agent CLI Error Envelope 暴露这个
事实。临时的 Refresh Transport Failure 可以重试，确定性的 Runtime Failure 保持显式错误。
显式 `start_session` 本身就是 Refresh，因此它的 Delivery 可能不确定；但该操作幂等，临时失败
后可以安全重试。
Queue Wait、Refresh、Driver Call 和 Screenshot Extraction 共用一个短于 Agent HTTP Transport
Timeout 的 Request Deadline。原 Tool 发送前到期时返回 `actionStarted: false`；Mutation 开始后
到期时遵循下文的 Uncertain Outcome 契约。

## Agent 与人工控制

ACP Agent 使用 Computer Tool；Terminal Agent 通过 `farming computer` 使用同一 Capability。

控制权始终只有一个 Owner。Agent 控制时用户观察；**接管**会阻止 Agent Action，并把交互权
交给用户；**交还 Agent**结束当前 Control Epoch，Agent 再次操作前必须先观察 Fresh State。

Action Timeout 属于结果不确定。Farming 必须先观察和对账，再决定 Retry；绝不自动重放。

## 安全与验收

Docker 中的桌面不能获得 Host Container Socket 或其它 Agent 的 Mutable State。验证覆盖
Installation Prerequisite、精确 Ownership、Browser Lease、Stop/Delete、Restart、Human Handoff、
Uncertain Action、Authentication 与并行 Docker 中的桌面。
