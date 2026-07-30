# Terminal 状态协议

[English](terminal-state-protocol.md)

Farming 使用自己带 Checkpoint 的持久 Terminal 协议：

1. PTY 产生有序字节流。
2. PTY Host 中的 Headless xterm 归约字节流，并可序列化当前屏幕。
3. 浏览器首次打开或重连时，只接收一次包含屏幕与精确尺寸的 Replay。
4. xterm 的 Replay Write Callback 完成后，才继续处理 Live Output。

## 可点击输出

Terminal Link 采用 VS Code 的分层 Detector 模型。OSC 8 Hyperlink 继续由 xterm 负责；普通 HTTP(S) 输出使用 Monaco Link Grammar，并采用与 xterm Web Link Provider 相同的 2,048 字符上限。本地文件层由 VS Code Terminal Link Parser 适配而来，支持 POSIX、Windows Drive、UNC、`file://` 路径，以及它的编译器和诊断位置后缀，包括 `path:line[:column[-endColumn]]`、`path:line.column`、带引号路径、括号/方括号、不换行空格和跨行范围。Python、C/C++、Clang 与 Shell Prompt Fallback 用于识别含空格路径。只有已识别的 Git Diff Header 才会移除 Diff 前缀。

检测只跨越由 `isWrapped` 连接的 xterm 逻辑行；显式换行绝不会被猜成 URL 续行。独立的 VS Code 风格多行层会把 ripgrep/ESLint 的数字结果行绑定到上方第一条非数字逻辑行，也会把 Git Hunk Header 绑定到上方的 `+++ b/path`。词法识别本身不授权打开文件：每个文件候选项必须先在捕获到的 Agent Workspace 中解析，无法解析的候选项保持普通文本。最后的 Word Fallback 使用 VS Code 兼容分隔符，单词最多 100 字符，只有按住修饰键点击时才打开 Project Files 搜索。URL 同样需要修饰键，已验证的文件目标可以直接打开。超过 2,000 字符的行、超过 1,024 字符的路径、每行十个以上的文件系统候选，以及超过 100 条逻辑行的多行回溯都会被拒绝或截断。

## Replay 状态

一次 Replay 携带：

```text
(runtimeEpoch, stateRevision, outputSeq, screen, cols, rows)
```

Epoch 标识一次 PTY 生命周期。Revision 和 Output Sequence 仅用于丢弃已被 Replay 覆盖的消息以及发现传输缺口；它们不是第二套业务状态机。

`GET /api/agents/:agentId/session-view` 返回当前 Replay。浏览器只在首次 Attach、重连、隐藏页面恢复或发现消息缺口时读取，不轮询。

Code 与 CRT 共用 `frontend/terminal-replay.js` 中的浏览器协议实现，包括 Epoch 排序、连续 Transition 判定、Replay Target、队列上限、Checkpoint 校验和重试策略。两个 Skin 只分别接入 Fetch 与 xterm，不再各写一套 Replay 状态机。传输失败按有上限的退避重试；同一个 Checkpoint 不变量连续失败时会停止恢复并显示错误，不会无限循环。

完整 Replay 写入期间 xterm 保持隐藏，Write Callback 完成后一次显示。因此用户长时间未连接后会直接看到最新屏幕，不再观看历史内容从上到下逐步绘制。

如果重连、重新 Attach、页面恢复或更新的 Bootstrap Cut 作废了一个已经进入 xterm 有序写队列的 Checkpoint，作废操作会立即释放旧的安装锁。旧写入仍可按队列顺序排空，但其完成回调受序号 Fence 保护，不能提交过期状态；替代 Checkpoint 会排在其后，并且始终能够推进到可见的权威 Cut。

Farming Code 会用一个由 Terminal Session Pool 持有状态的中央恢复提示，把这段原子换屏边界显式呈现给用户。提示区分 Checkpoint 获取、画面安装和失败退避重试，并显示已等待时长与当前尝试次数。提示有 500 ms 展示宽限：普通 Attach 如果在这个窗口内提交权威 Cut，就只显示最终终端画面；确实较慢的恢复仍会显示实时阶段。停放的 xterm Host 会在回到可见 Mount 之前先隐藏，因此旧 Buffer 不会在这段宽限期内闪现。提示一旦出现，只有权威 Cut 已提交到 xterm 后才消失。Renderer 或 Checkpoint 不变量失败仍由 Terminal 的显式失败卡片负责。

## 浏览器 Attach 所有权

Terminal Session Pool 为每个 Agent 持有唯一的 `SessionRecord`。浏览器 Attachment 的身份只由 Agent id 与 Mount Element 决定。只有这两个身份发生变化、Pane Unmount、传输重连、隐藏页面恢复或发现 Replay 缺口时，才允许进入 Recovery；普通 React Render 不得触发 Recovery。

React 边界获取 Attachment Lease，而不是在 Effect Cleanup 中直接执行 Detach。它的状态模型是 `detached -> attached -> release-pending -> detached`。Cleanup 只进入 `release-pending`；如果同一次 Commit 中仍是同一个 Agent 和同一个 Mount 重新获取 Lease，就取消释放并保持 `attached`，不会推进 Generation。Agent 或 Mount 真正变化时，先释放旧 Owner 再挂载新 Owner。旧 Lease 无法释放更新的 Owner；如果下一次 Microtask 前没有重新获取，才提交真实释放。Session Pool 同时把当前 Agent 与 Mount 的重复 Attach 视为幂等，因此即使绕过 React 协调器，也不能意外启动 Checkpoint Recovery。

事件回调、输入开关、光标抑制和更新的 Bootstrap 数据都属于 Live Options。它们只能原地更新已有 `SessionRecord`，不能 Detach Host、推进 Attachment Generation 或发布 `requesting` 恢复状态。Browser Controller 同样提供稳定的命令函数，Resource Collection 更新不能造成下游回调身份抖动。响应式浏览器测试会在桌面与多种手机尺寸之间反复切换，并要求全过程 Attachment Generation 不变且恢复遮罩不出现。

Live WebSocket Output 使用 Leading-edge 且有帧率上限的合并策略：空闲后的第一条 Transition 立即发送，以保证打字响应；持续输出仍会合并，但不会丢失任何单独的 Transition Index。浏览器仍会逐条校验和提交索引，并把连续的 Output / Clear 一次写入 xterm。Resize 是有序的批次边界：提交 Resize 后，浏览器等待后续重画静默 50 ms（最长 300 ms），再一次性绘制该 Burst；普通非 Resize Output 继续走低延迟路径。

## 受支持的浏览器 Renderer

Code 与 CRT 统一以 xterm.js WebGL 作为唯一受支持的产品 Renderer。Renderer 生命周期刻意保持为 `pending -> webgl -> failed`。WebGL 初始化失败或发生不可恢复的 Context Loss 时，Terminal 必须显式失败；重试只重建同一条 WebGL 路径，Live Terminal 不能静默切换到 DOM Renderer。

浏览器持续测试能力有限，因此架构不能积累无法按同一验收标准持续覆盖的备用 Renderer。没有持续运行测试的路径不是可靠 Fallback。测试和产品代码都只面向这一套 Renderer 状态机，不维护 Fallback 专属行为。Ghostty 只保留为开发者显式诊断模式，不进入受支持的产品 Renderer 状态机。

## 输入与 Resize

Input 直接来自 xterm `onData`，并按原始字节写入 PTY。Farming 不增加输入 ACK、去重、自动重放、Controller Lease 或 Takeover UI。多个 Code/CRT 页面可以同时输入，服务端按到达顺序串行写入。切换已有 Agent 只是本地 View 变化，不能借机刷新完整 `state` 文档。已聚焦 Terminal 的 Live Output 必须先于延迟的小型 Activity Projection 到达；其 Preview 也不再携带浏览器已经拥有的权威屏幕 Snapshot。

发布 Gate `npm run test:pre-release:terminal-input` 使用两个确定性的本地 Bash Session：在已有 Agent 之间切换、通过 xterm 连续输入和删除、拒绝 Focus 后完整 `state` Frame、要求已聚焦 Preview 小于 8 KiB，并将 Loopback 的按键到 `session-output` p95 限制在 250 ms。它约束的是本地产品路径的回归，不宣称任意远端网络延迟；Release Checklist 仍要求单独进行真人式远端 Dogfood Smoke。

Resize 也是共享的。所有由浏览器 Layout 触发的 Geometry 变化都以完整 `cols + rows` 为单位做尾部合并，避免一次持续窗口拖动反复触发 xterm Reflow 和全屏 TUI 重画；这条规则不再按 Output 长度或 Normal/Alternate Buffer 状态分支。显式 Attach，以及 Recovery 期间实际观察到的 Layout 变化，不经过这段延迟。服务端随后最多保留一个 In-flight Resize 和一个 Latest Pending Size。浏览器应用服务端已提交的远端 Resize 时不会再次回传。普通 Checkpoint Recovery 完成时也不会无条件抢回该浏览器先前请求过的尺寸，否则不同尺寸的多个 Viewer 会在 Resize、全屏重画、Backpressure 断连与恢复之间形成无限反馈环。

## Backpressure 与恢复

PTY Host 只在 Headless Reducer 提交后发布 Output。Reducer 积压时可以暂停读取 PTY。不同浏览器的慢 WebSocket 相互隔离，不存在 Browser Renderer Debt 协议。

显式远端 Chaos Smoke 通过 `FARMING_REMOTE_URL=... FARMING_REMOTE_TOKEN=... npm run test:remote-terminal:chaos` 运行。它会创建并最终删除两个隔离的 Shell Agent，用相互独立的桌面与手机浏览器 Context 驱动同一个重画密集型 Terminal；操作之间不等待 Ready，并注入高延迟、离线恢复、Viewport 抖动、Reload、切换和输入。验收边界面向用户且有明确时限：不能持续出现无解释白屏，Recovery 必须收敛，重画状态必须停止推进，两个 Viewer 在恢复后的输入都必须恰好到达一次。每次运行都会把确定性的操作轨迹和失败截图保存在 `.tmp/remote-terminal-chaos/`。

兼容的 Farming Server 重启会重新连接仍存活的 Native PTY Host；不兼容 Host 轮换前会序列化屏幕。PTY Host 意外崩溃属于进程丢失，不能伪装成成功 Replay。
