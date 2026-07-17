# Terminal 状态协议

[English](terminal-state-protocol.md)

Farming 使用自己带 Checkpoint 的持久 Terminal 协议：

1. PTY 产生有序字节流。
2. PTY Host 中的 Headless xterm 归约字节流，并可序列化当前屏幕。
3. 浏览器首次打开或重连时，只接收一次包含屏幕与精确尺寸的 Replay。
4. xterm 的 Replay Write Callback 完成后，才继续处理 Live Output。

## Replay 状态

一次 Replay 携带：

```text
(runtimeEpoch, stateRevision, outputSeq, screen, cols, rows)
```

Epoch 标识一次 PTY 生命周期。Revision 和 Output Sequence 仅用于丢弃已被 Replay 覆盖的消息以及发现传输缺口；它们不是第二套业务状态机。

`GET /api/agents/:agentId/session-view` 返回当前 Replay。浏览器只在首次 Attach、重连、隐藏页面恢复或发现消息缺口时读取，不轮询。

Code 与 CRT 共用 `frontend/terminal-replay.js` 中的浏览器协议实现，包括 Epoch 排序、连续 Transition 判定、Replay Target、队列上限、Checkpoint 校验和重试策略。两个 Skin 只分别接入 Fetch 与 xterm，不再各写一套 Replay 状态机。传输失败按有上限的退避重试；同一个 Checkpoint 不变量连续失败时会停止恢复并显示错误，不会无限循环。

完整 Replay 写入期间 xterm 保持隐藏，Write Callback 完成后一次显示。因此用户长时间未连接后会直接看到最新屏幕，不再观看历史内容从上到下逐步绘制。

Live WebSocket Output 使用 Leading-edge 且有帧率上限的合并策略：空闲后的第一条 Transition 立即发送，以保证打字响应；持续输出仍会合并，但不会丢失任何单独的 Transition Index。

## 受支持的浏览器 Renderer

Code 与 CRT 统一以 xterm.js WebGL 作为唯一受支持的产品 Renderer。Renderer 生命周期刻意保持为 `pending -> webgl -> failed`。WebGL 初始化失败或发生不可恢复的 Context Loss 时，Terminal 必须显式失败；重试只重建同一条 WebGL 路径，Live Terminal 不能静默切换到 DOM Renderer。

浏览器持续测试能力有限，因此架构不能积累无法按同一验收标准持续覆盖的备用 Renderer。没有持续运行测试的路径不是可靠 Fallback。测试和产品代码都只面向这一套 Renderer 状态机，不维护 Fallback 专属行为。Ghostty 只保留为开发者显式诊断模式，不进入受支持的产品 Renderer 状态机。

## 输入与 Resize

Input 直接来自 xterm `onData`，并按原始字节写入 PTY。Farming 不增加输入 ACK、去重、自动重放、Controller Lease 或 Takeover UI。多个 Code/CRT 页面可以同时输入，服务端按到达顺序串行写入。切换已有 Agent 只是本地 View 变化，不能借机刷新完整 `state` 文档。已聚焦 Terminal 的 Live Output 必须先于延迟的小型 Activity Projection 到达；其 Preview 也不再携带浏览器已经拥有的权威屏幕 Snapshot。

发布 Gate `npm run test:pre-release:terminal-input` 使用两个确定性的本地 Bash Session：在已有 Agent 之间切换、通过 xterm 连续输入和删除、拒绝 Focus 后完整 `state` Frame、要求已聚焦 Preview 小于 8 KiB，并将 Loopback 的按键到 `session-output` p95 限制在 250 ms。它约束的是本地产品路径的回归，不宣称任意远端网络延迟；Release Checklist 仍要求单独进行真人式远端 Dogfood Smoke。

Resize 也是共享的。所有由浏览器 Layout 触发的 Geometry 变化都以完整 `cols + rows` 为单位做尾部合并，避免一次持续窗口拖动反复触发 xterm Reflow 和全屏 TUI 重画；这条规则不再按 Output 长度或 Normal/Alternate Buffer 状态分支。显式 Attach 与 Recovery Fit 不经过这段延迟。服务端随后最多保留一个 In-flight Resize 和一个 Latest Pending Size。浏览器应用服务端已提交的远端 Resize 时不会再次回传。

## Backpressure 与恢复

PTY Host 只在 Headless Reducer 提交后发布 Output。Reducer 积压时可以暂停读取 PTY。不同浏览器的慢 WebSocket 相互隔离，不存在 Browser Renderer Debt 协议。

兼容的 Farming Server 重启会重新连接仍存活的 Native PTY Host；不兼容 Host 轮换前会序列化屏幕。PTY Host 意外崩溃属于进程丢失，不能伪装成成功 Replay。
