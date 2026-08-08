# Farming Computer Use

> English version: [computer-use.md](./computer-use.md)

用户指南：[Computer Use（实验性）](https://zhuwenzhuang.github.io/farming/cn/experimental/computer-use)。
本文继续作为生命周期、所有权、隔离和验收契约。

Computer Use 是可选的完整 Desktop 能力，包括 Application、Native Dialog、Mouse、Keyboard、
Screenshot 与 Accessibility Information。Browser 继续负责结构化网页与 DOM。

## Desktop Target

- **Local Desktop** 表示 Host 现有图形桌面，需要持续验证的 Native Driver 与单一 Control Owner。
- **Isolated Desktop** 为 Agent 提供独立 Linux Desktop；显式准备所需 Container Runtime 后，
  它是当前受支持目标。

Farming 只展示拥有真实、已验证 Runtime 的 Target。前置条件缺失时显式说明，不提供低质量 Fallback。

## Ownership 与生命周期

一个 Agent 最多拥有一台 Isolated Desktop 及其精确 Runtime。不同 Agent 不共享 Desktop
Session、Credential、Profile 或 Private Endpoint。

- Chat/Terminal 与 Permission Replacement 保留 Desktop。
- 停止或归档 Agent 会停止 Runtime，但保留 Resource。
- 删除 Agent 会删除它精确拥有的 Desktop。
- Browser 正在使用 Desktop 时，必须先释放 Lease 才能停止 Desktop。

破坏性操作前必须验证精确 Ownership。Viewer 通过带鉴权的 Farming Boundary 提供，而不是
暴露公开 Desktop Endpoint。

Resource 拥有唯一的 driver session 身份。Agent 幂等调用 `start_session` 时，会在 driver
idle-TTL 回收后刷新或重建这个确切 session；调用方提供的 session 身份不能替换它。

## Agent 与人工控制

ACP Agent 使用 Computer Tool；Terminal Agent 通过 `farming computer` 使用同一 Capability。

控制权始终只有一个 Owner。Agent 控制时用户观察；**接管**会阻止 Agent Action，并把交互权
交给用户；**交还 Agent**结束当前 Control Epoch，Agent 再次操作前必须先观察 Fresh State。

Action Timeout 属于结果不确定。Farming 必须先观察和对账，再决定 Retry；绝不自动重放。

## 安全与验收

Isolated Desktop 不能获得 Host Container Socket 或其它 Agent 的 Mutable State。验证覆盖
Installation Prerequisite、精确 Ownership、Browser Lease、Stop/Delete、Restart、Human Handoff、
Uncertain Action、Authentication 与 Parallel Isolated Desktop。
