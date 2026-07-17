# Terminal 状态协议

[English](terminal-state-protocol.md)

Farming 采用 VS Code 的持久终端模型：

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

Code 与 CRT 共用 `frontend/terminal-replay.js` 中的浏览器协议实现，包括 Epoch 排序、连续 Transition 判定、Replay Target、队列上限、Checkpoint 校验和重试策略。两个 Skin 只分别接入 Fetch 与 xterm/DOM，不再各写一套 Replay 状态机。传输失败按有上限的退避重试；同一个 Checkpoint 不变量连续失败时会停止恢复并显示错误，不会无限循环。

完整 Replay 写入期间 xterm 保持隐藏，Write Callback 完成后一次显示。因此用户长时间未连接后会直接看到最新屏幕，不再观看历史内容从上到下逐步绘制。

## 输入与 Resize

Input 直接来自 xterm `onData`，并按原始字节写入 PTY。Farming 不增加输入 ACK、去重、自动重放、Controller Lease 或 Takeover UI。多个 Code/CRT 页面可以同时输入，服务端按到达顺序串行写入。

Resize 也是共享的。浏览器提交当前尺寸，服务端合并尚未处理的 Resize，只执行最后收到的尺寸。浏览器应用服务端已提交的远端 Resize 时不会再次回传。

## Backpressure 与恢复

PTY Host 只在 Headless Reducer 提交后发布 Output。Reducer 积压时可以暂停读取 PTY。不同浏览器的慢 WebSocket 相互隔离，不存在 Browser Renderer Debt 协议。

兼容的 Farming Server 重启会重新连接仍存活的 Native PTY Host；不兼容 Host 轮换前会序列化屏幕。PTY Host 意外崩溃属于进程丢失，不能伪装成成功 Replay。

## VS Code Reference

对应的 VS Code 机制是：

- `basePty.ts`：应用 Replay 尺寸，并等待每次 xterm Tracked Write。
- `ptyService.ts`：持有 Headless xterm Serializer 与 Persistent Process Replay。
- `terminalInstance.ts`：xterm 解析 Live Output 后再确认。
- `terminalResizeDebouncer.ts`：合并 Resize。

Farming 沿用相同 Replay 边界，但保留自己的 HTTP/WebSocket 传输。
