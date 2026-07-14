# Farming CRT

> English version: [README.md](./README.md)

Farming CRT 是 Farming 2 的键盘优先控制室。它不是旧的只读皮肤，也不是低保真 Fallback：它控制的是与 Farming Code 相同的 Live Agent、结构化 ACP Session、原生 PTY、Search、History、Settings 和 Usage Data。

![Farming CRT 控制台](assets/01-crt-dashboard.png)

多个 Agent 同时运行、终端输出是主要信号，或者直接键盘控制比 Coding Workspace 更快时，适合使用 CRT。Files、Editing、工作区 Review 和手机访问请使用 [Farming Code](../code/README.zh_cn.md)。切换界面不会重启或复制 Agent。

共享能力的完整矩阵见 [Farming 2 产品总览](../README.zh_cn.md)。

## Dashboard 是实时控制室

Agent Card 占据稳定机位，不会跟随 Activity 不断缩放。一到四个 Agent 使用 `2 × 2`，五到六个使用 `3 × 2`，七到九个使用 `3 × 3`；更多 Agent 每九个一页。小屏幕会先减少可用行或列，避免 Card 低于可读尺寸。

每张 Card 展示：

- 用户 Rename、Provider Session Title、Terminal Title 或友好 Provider Name；
- Running、Waiting、Unread 和可选 Heat 状态；
- 配置后的 Project Name；
- Bottom Aligned、ANSI Aware 的实时 Terminal Preview；
- 稳定数字快捷标记。

Top Bar 展示 Active Agent、Terminal Output Token Rate 估计、CPU/MEM、Host Identity、本地时间和 Uptime。Sidebar 保持 New Agent、Search、History、Billing、Settings 和可选 Main Agent 监督直接可达，同时不遮住 Grid。

方向键移动反色选中，Enter 打开，Escape 退出当前 Console。在分页边界继续按 Up / Down 会自然进入上一页或下一页，并保留选中列。

## 不离开 CRT 就能打开结构化 Chat

Codex、Claude Code、OpenCode 和 Qoder ACP Session 会打开全屏磷光 Chat，而不是伪装成 PTY Output。

![Farming CRT 结构化 Chat](assets/02-crt-structured-chat.png)

History Replay 与 Live Entry 保持顺序。Transcript 显示 User / Agent Message，Composer 根据支持情况提供 Provider Command、Model / Mode Configuration、Token Usage、Attachment、Pasted Image、Permission Request、Queued Follow-up 和 Interrupt。

Composer 围绕终端式键盘使用设计：

- Enter 发送，Shift+Enter 换行；
- 中文 IME 确认不会被误判为提交；
- Down 从 Draft 移动到 Control Strip；
- Left/Right 选择 Control，Enter 打开有限高度的 Option；
- Transcript 溢出时，Tab 聚焦，方向键翻页，Enter 回到最新消息；
- Escape 返回一层，在 Session Root 关闭 Chat。

只有 Focused Terminal Runtime 会挂载 xterm。结构化 Session 仍然保持原生结构化语义，Recovery Error 会显示在 Composer 内。

## 打开真实 Terminal

Terminal Session 使用全屏 xterm.js，保留原生 Keyboard、IME、ANSI Color、Scrollback、Selection、Copy 和全屏 TUI 行为。

![Farming CRT 原生 Terminal](assets/03-crt-terminal.png)

Terminal 会先恢复与当前尺寸匹配的 Backend Screen，再接收增量 Output。这对 OpenCode、Qoder 等全屏 CLI 很重要：重放任意 ANSI Tail 不是合法终端状态。

普通 Escape 继续交给 Terminal Application；`Ctrl+Escape` 关闭 CRT Terminal，`Ctrl+K` Kill Agent。打开的 Terminal 要求产品 xterm WebGL2 路径，不会静默降级成低保真 Renderer。

## 用 MSG / TTY 切换实际运行时

兼容 Session Header 提供 `MSG` 和 `TTY`，并显示 `Alt+M` 快捷键。这会修改后端运行时，而不是只换表现：

- `MSG` 重启到 ACP 结构化 Chat；
- `TTY` 重启到 Native PTY CLI；
- Provider Session Identity 已经形成时 Resume 同一个 Session；
- Overlay 显示准备、重启和失败状态，然后跟随 Replacement Agent ID。

全新 Terminal 没有用户输入时，可以在 Provider History 尚未形成之前进入新 Chat。一旦 Terminal 已有输入，History Identity 缺失会继续作为可见错误，Farming 不会静默丢弃对话。

## 搜索实时与历史工作

按 `F` 或选择 **[F] SEARCH**。Query Console 会匹配 Live Agent Title、配置的 Project Name 和 Workspace Path，然后从共享 Provider Archive 加入可 Resume 的 Codex、Claude Code、OpenCode 和 Qoder Session。

![Farming CRT Search](assets/04-crt-search.png)

Live Agent 排在前面；已经由 Live Agent 代表的 Provider Session 会被移除。Up/Down 在 Query 保持 Focus 时移动结果，Enter 打开或 Resume，Escape 返回 Dashboard。

## 从 History Continue、Restore 或 Resume

按 `H` 打开与 Farming Code 相同的 History Scope：Farming Run Record、已归档的受支持 Coding Agent、尚未被占用的 Provider Session，并按 Identity 去重。

![Farming CRT History](assets/05-crt-history.png)

每行明确展示 Coding Agent 与 Workspace。主操作会明确写成 Continue、Open、Restore 或 Resume，不会从 UI 状态猜测。Up/Down 跨页连续移动，Left/Right 整页切换，Enter 执行，Escape 返回。

Shell 和未知命令不会进入可 Resume 的 Provider History。它们归档时会销毁进程，而不是伪装成可恢复 Coding Session。

## 查看按日与实时 Token 遥测

**[$] BILLING** 是运行 Token Console，不是金额账单。

### Days

默认视图组合 120 天对数 Processed Token Chart 和 52 周 Activity Strip。Cache 与 Direct Token 分层显示，安静日期和十亿 Token 峰值都保持可读。

![CRT Billing Days](assets/06-crt-billing-days.png)

选择日期可以查看精确 / 紧凑 Total、Input、Output、Cache Read/Write、24 个一小时 Bin，以及 Codex/Claude/OpenCode Share。当天会标记 Partial；跨午夜 Session 的 Provider Event 会按本地日期拆分。

### Live

按 `L` 打开 60 分钟 Token Rate 示波器、5 分钟 Provider Channel、Quota Window 和 Reset Timing。

![CRT Billing Live](assets/07-crt-billing-live.png)

Total 是 Provider 报告的 Processed Token，并包含 Cache Read；不是 Cost 或 Rate Limit Consumption。Quota Telemetry 缺失会显式说明。Qoder Local Session 没有 Token Field 时仍会显示为 Unavailable，Farming 不会根据 Terminal Output 估算。

## 调整 CRT，不影响 Farming Code

Settings 提供 Interface Switch、CRT Effects、可选 Dynamic Heat、10–20 px Opened Terminal Text Size、Runtime Information 和 Permission Default。

![Farming CRT Settings](assets/08-crt-settings.png)

- CRT Effect 只作用在 CRT Root，不会泄漏到 Farming Code。
- Opened Terminal Font Size 立即更新，Agent Preview Density 保持稳定。
- Dynamic Heat 默认关闭，让 Card 尺寸和颜色稳定。
- Reduced Motion Preference 会关闭依赖运动的效果。
- 选择 Farming Code 会回到共享 Code Session，不重启 Agent。

禁用的 **[E] EXTENSIONS** 位置保留给未来 Provider Neutral Extension Surface。CRT 不会独立推断或安装 Extension。

## 手机端状态

Farming CRT 当前只作为桌面界面支持。手机请使用 Farming Code。CRT 移动布局仍是概念方案，不作为当前产品能力展示。

## 实时渲染与重连

Dashboard Preview 是监控摘要，不是交互式 Terminal Canvas。Client 最多每秒批处理一次变化，只更新受影响 Card。Session 打开时，该 Client 暂停后台 Dashboard Render 与 Preview Stream；关闭时只请求一次最新合并 State。

浏览器 Tab 隐藏时，CRT 会关闭 WebSocket 并取消重连工作，后端 Agent 和 PTY 继续运行。再次回来时只建立一个连接，恢复 Dashboard State，并在增量 Output 前同步 Open Terminal。

Unread Card 使用独立磷光外框，不改变 Layout。打开 Agent 会推进与 Farming Code 共享的 Attention Read Cursor。

## 打开 CRT

实时入口是：

```text
<base-path>/crt/
```

默认配置下打开 `/farming/crt/`。也可以在 Farming Code Settings 中切换，并把当前 Focused Agent 带入 CRT。

## 详细设计文档

- [Farming 2 产品总览](../README.zh_cn.md)
- [CRT 共享布局模型](base_layout.zh_cn.md)
- [桌面布局规则](pc_layout.zh_cn.md)
- [移动端布局规则](mobile_layout.zh_cn.md)
- [Zombie Cleanup 与 History 实现](zombie-history-implementation.zh_cn.md)
- [仓库 README 与安装](../../../README.zh_cn.md)
