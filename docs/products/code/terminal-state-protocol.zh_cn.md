# Terminal 状态协议

[English](terminal-state-protocol.md)

Farming Terminal 采用 VS Code 持久终端的成熟模型：PTY 进程产生有序字节流，Headless Terminal Reducer 持有权威展示状态，浏览器 Renderer 只是可替换的状态视图。由于同一个终端可能同时打开在多个浏览器窗口或皮肤中，Farming 额外增加了显式 Controller Lease。

## 权威状态

一个 Live PTY Runtime 的 Display 与 Control 是两套互相独立的状态机。权威展示状态是：

```text
(runtimeEpoch, stateRevision, outputSeq, screen, cols, rows)
```

- `runtimeEpoch` 标识一次具体 PTY 进程生命周期。
- `outputSeq` 在每个已提交 PTY Output Transition 后递增。
- `stateRevision` 在每个已提交展示状态 Transition 后递增。Output 同时推进 `outputSeq` 和 `stateRevision`；Clear、Resize 只推进 `stateRevision`。
- `screen`、`cols`、`rows` 来自 PTY Host 中的 Headless xterm Reducer。

Controller Lease 单独建模：

```text
(claimedRuntimeEpoch, leaseId, fence, expiresAt, rendererReadyFence)
```

`leaseId` 与 `fence` 使旧浏览器 Controller 的 Input、Resize、Clear 和 Output ACK 永久失效。`claimedRuntimeEpoch` 在一次 Lease 内不可变化；PTY Epoch 变化时旧 Lease 必须失效，不能静默迁移。Controller 回包不得携带或推进 Display Revision、Output Sequence、Dimensions 或 Checkpoint。

只有 Reducer 提交了对应 Transition，PTY Host 才能发布 Output。一个合法 Checkpoint 的 Epoch、序号、Screen 和尺寸必须来自同一个已提交状态切面。

## `/session-view`

`GET /api/agents/:agentId/session-view` 返回 Session 当前的权威视图。它是 Checkpoint API，不是 Event Log，也不是第二套 Terminal Emulator。

浏览器只在首次 Attach、重连、页面从挂起恢复、发现序号缺口或队列溢出、Runtime Epoch 变化时读取它。浏览器一次性安装 Checkpoint，删除已被覆盖的排队 Transition，之后只接受同 Epoch 中严格连续的增量。浏览器不会轮询 `/session-view`；正常 Resize 与 Clear 也不读取 Checkpoint。

因此，用户很久没有连接后不会再逐秒追赶历史输出。浏览器会直接跳到一个可以证明的最新 Screen，再从精确序号边界继续 Live Output。

正常 Live Display 变化共用一条有序 Transition Log：

| Transition | `stateRevision` | `outputSeq` | Payload |
| --- | --- | --- | --- |
| output | +1 | +1 | PTY Bytes |
| resize | +1 | 不变 | `cols`、`rows` |
| clear | +1 | 不变 | Clear Operation |

当前 Controller 会先立即 Resize 本地 xterm，再提交带 Fence 的 PTY Resize，与 VS Code 的 Live Resize 顺序一致；其他 Viewer 应用已提交的 Resize Transition。若请求失败，则通过权威 Checkpoint 恢复，绝不让 Resize Timer 充当 Display Commit。

## 输入与多 Viewer

Terminal Input 保持与 VS Code 一致的 Raw PTY Byte Stream。Farming 不增加逐键或逐输入 ACK、去重和自动重放。

浏览器只使用 xterm `onData` 作为输入来源，包括中文 IME Commit 与 Paste；不再使用按时间猜测的 Textarea Fallback，因此不会在 Checkpoint 或 Takeover Pending 时重复中文。Controller Claim 或 Renderer Commit Pending 期间产生的输入进入有界、绑定 Epoch 的队列，仅在 Controller Ready 后发送一次；Epoch 变化会显式丢弃尚未发送的旧输入。

同一时刻只有一个可见 Attachment 持有 Controller Lease。Code 和 CRT Observer 保持只读，直到用户显式点击 **Take control**。Input、Resize、Clear 和 Renderer Output ACK 都携带 Lease ID、Fence 和预期 Runtime Epoch；旧操作会被拒绝。

遇到不确定的传输断线时，Farming 不自动重发 Terminal Input，因为重放一个执行状态不确定的命令可能导致执行两次。展示状态通过 Checkpoint 恢复；输入保持直接发送并显式暴露失败。

## Output Flow Control

PTY Host 分别跟踪：

- 等待权威 Reducer 处理的字节；
- 已交付给 Owner 浏览器 Renderer、但尚未确认完成的字符。

浏览器只在 xterm Write Callback 后发送 Output ACK。超过 High Watermark 时 Host 暂停 PTY，降到 Low Watermark 后恢复。Controller Takeover 会清除旧 Owner 的 Renderer Debt，因此一个卡死或关闭的窗口不能永久冻结共享 PTY。

## 恢复边界

| 事件 | 进程身份 | 展示恢复 |
| --- | --- | --- |
| 浏览器重连、Reload、隐藏页面恢复 | 同一 PTY、同一 Epoch | 安装 `/session-view`，然后继续连续 Live Output |
| 兼容 PTY Host 仍存活时 Farming Server 重启 | 同一 PTY、同一 Epoch | 重新 Attach Host 并安装 Checkpoint |
| 升级时受控轮换不兼容 PTY Host | 新 PTY、新 Epoch | Freeze Mutation，Drain Reducer，准备带 Token 的序列化 Checkpoint，停止旧 Host，启动新进程，恢复序列化 Screen，并显示 `History restored` |
| PTY Host 意外崩溃 | 旧 PTY 已丢失 | 明确报告 Terminal 丢失，不声称旧进程或未确认 Input 仍然存活 |

受控轮换是 Transactional 的：准备期间阻止新 Mutation；在状态切面前已经退出的 Session 不进入快照；序列化失败会恢复旧 Host 并终止轮换；关闭旧 Host 必须携带匹配的 Preparation Token。

## Safety 与 Liveness

Safety 义务：

- 浏览器不能混合不同 Epoch 的 Transition；
- Duplicate 或 Stale Transition 不能修改展示；
- 出现 Gap 时不能在没有 Checkpoint 的情况下推进展示；
- 每个 Checkpoint 必须对应 Reducer 实际提交的唯一状态切面；
- Resize、Clear 与 Output 共用同一条有序 Revision 空间；
- Takeover 后旧 Controller 不能 Input、Resize、Clear 或确认 Output；
- Controller Lease 不能跨越 PTY Runtime Epoch；
- 受控轮换失败时不能主动销毁尚未生成 Checkpoint 的 Live PTY。

Liveness 义务：

- Transport Failure 通过有界 Backoff 重试 Checkpoint；连续四次收到违反同一 Checkpoint 不变量的相同响应时，必须停止自动重试并显式失败，直到用户明确重连；
- Reducer 或 Renderer 积压时暂停 PTY，而不是丢 Output；
- 健康 Controller Takeover 必须解除旧 Renderer Backpressure；
- 每次受控轮换最终要么提交到新 Host，要么恢复旧 Host；
- 意外进程丢失必须显式终止，不能永久停留在 Pending 状态。

Timer 不证明 Display 正确性。Lease Expiry Scheduler 和浏览器 Renew Watchdog 只负责 Controller Liveness；Request Deadline 只负责令请求失败；Batching 与 Layout Timer 只影响性能。任何 Timer 都不能创建 Revision、越过 Gap、完成 Replay 或确认 Renderer Output。

## VS Code Reference

术语和恢复边界参考 VS Code 的持久终端实现：

- [`basePty.ts`](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/terminal/common/basePty.ts)：Process Replay、`OverrideDimensions`、Tracked Renderer Commit 与 Replay Complete。
- [`localPty.ts`](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/terminal/electron-browser/localPty.ts)：Replay 期间阻止 Input、Resize 与 Output ACK。
- [`ptyService.ts`](https://github.com/microsoft/vscode/blob/main/src/vs/platform/terminal/node/ptyService.ts)：Persistent Terminal Serialization、Live Resize 顺序、Process Revival 与 `History restored` 边界。
- [`terminalInstance.ts`](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/terminal/browser/terminalInstance.ts)：先 Resize 本地 xterm，再更新 PTY Dimensions。

Farming 的 Browser Controller Lease 是多窗口、多皮肤产品模型所需的额外边界；它不改变 Raw PTY Input 语义。
