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

所有 Same-origin Routing 遵循 Server 提供的 Base Path。Routing 缺失、Protocol Incompatibility、
Renderer Failure 与 Session Recovery Failure 都必须显式展示；CRT 不静默切换到未测试 Fallback。

## 验收标准

验证必须覆盖：Keyboard-only Operation、Empty/Dense Dashboard、Agent Ordering Stability、Code/CRT
Switch、Chat/Terminal Continuity、Search、History、Settings、Capability Failure、Renderer Failure、
Reconnect、Restart，以及 Desktop Viewport 下的大规模 Live Agent Inventory。
