# ACP 后端 Runtime

> English version: [acp-runtime.md](./acp-runtime.md)

Farming 现在提供一条面向 Codex、Claude Code、OpenCode 和 Qoder 的 Agent Client Protocol runtime。后端生命周期与前端展示刻意分离：后端负责 Agent 进程、ACP Session 生命周期、统一状态和控制 API，`src/components/code/acp/` 则只描述 ACP Chat 行为。

## Provider 连接

- Codex 使用锁定版本的 `@agentclientprotocol/codex-acp` adapter。
- Claude Code 使用锁定版本的 `@agentclientprotocol/claude-agent-acp` adapter。
- OpenCode 使用自身的 `opencode acp --cwd <workspace>` 命令。
- Qoder 使用自身的 `qodercli --acp` 命令。Qoder 可能在 `session/load` 返回之后继续发送历史尾部，因此 Farming 会等待 replay stream 稳定后再暴露恢复完成的 Session。
- 四者都通过官方 `@agentclientprotocol/sdk`，在子进程 stdio 上使用按行分隔的 JSON-RPC 通信。

Adapter 包使用精确版本的 production dependency。Farming 启动 Agent 时不会执行 `npx latest`。

## Session 语义

只要 Agent 声明对应 capability，runtime 就支持 ACP 的 `initialize`、`session/new`、`session/load`、`session/resume`、`session/list`、`session/fork`、`session/delete`、`session/close`、`session/set_mode`、`session/set_config_option`、`session/prompt` 和 `session/cancel`。

已有历史 Session 默认使用 `session/load`。这是因为 ACP load 会在请求返回之前，通过 `session/update` notification 重放完整对话；显式 `resume` 只恢复上下文，不重放旧消息。Farming 会先注册 Session reducer，再发出 load，确保不会漏掉提前到达的历史 notification。

后端会缓存完整的受支持历史元数据窗口，并通过稳定 cursor 向 Farming Code 分页返回。滚动接近项目列表底部时加载下一页；项目里的“显示更多”仍只控制已加载页面内的本地展示。恢复历史时会在后端完整窗口内解析 provider 元数据，因此较老的 Session 在 Terminal 与 Chat 之间切换时仍能保留原工作区。Qoder 历史发现只把项目级 transcript 文件视为 Session；嵌套的子 Agent transcript 属于重放细节，不会再生成重复历史行。

ACP update 一方面以有界 raw 数据保留，另一方面归约到一条与 provider 无关的有序 entry stream。历史重放和实时更新使用同一个 reducer；相邻且 message id 兼容的 message chunk 合并，tool update 按 id 原位更新最初的 tool-call entry，plan entry 原位更新。usage、mode、command 和 config option 等 Session 元数据不混入对话流。runtime notification 只携带轻量失效信息，避免历史重放时反复复制不断增长的 transcript。

## Farming Code 展示

ACP 在 `src/components/code/acp/` 下拥有独立的 composer、草稿命名空间、权限卡片、Session 控件、动态命令菜单和 transcript adapter。Terminal 继续使用 `CodeComposer` 与 PTY 输入路径，不加入 ACP 分支。

Composer 展示当前 ACP Session 协商出的 mode、model、reasoning、boolean option、usage 和 available commands。现有 Chat UI 设计保持不变：adapter 把 canonical ordered entries 投影到原有的用户/结果/过程 view model，不修改 composer 或 transcript 的组件层级。投影把可见用户消息之后的最后一条 assistant entry 作为结果，把此前的 commentary、thought、tool 和 plan 收入原有可逆的“执行过程”折叠区。包含 ACP `diff` block 的 tool update 还会投影为现有的文件修改结果卡，点击后打开该工作区当前的 Review 页面。Tool 的 raw input/output、带上下文的紧凑 patch、terminal 和 location 仍可展开。ACP transcript 跟随共享状态 WebSocket 的 Session 更新信号刷新，不再反复下载没有变化的空闲历史。Codex 内部 context 与 heartbeat 活动按 segment 隐藏，但真正需要通知用户的 automation 结果仍作为 assistant message 保留。

ACP Composer 保留所有不依赖 PTY 输入的日常消息框行为：草稿与上下键历史、Enter/Shift+Enter 与中文输入法、文件选择、粘贴图片预览、删除附件、语音输入、Agent 命令与 Skill、Goal/Plan 请求模式、排队的 follow-up、中断、存在精确 Codex 数据时的上下文窗口，以及 Agent 提供的权限和配置控件。`+` 菜单包含附件、目标和计划；Agent 命令通过 `/` 搜索，`$` 则搜索 Agent 实际宣告的 Skill 子集。上传图片会作为原生 ACP image content block 发送；文本文件仍嵌入消息，图片上传不可用时保留原有文本降级。

对 Codex，Farming 会把选中的启动配置映射到 ACP adapter 的 `CODEX_CONFIG` 和 `INITIAL_AGENT_MODE`。因此 Terminal 与 Chat 之间切换时，会继承模型、推理强度、速度层级和对应的初始权限模式，不再静默回到 adapter 默认值。

ACP 的边界保持明确：

- ACP 没有并发 prompt/steer 操作。Agent 工作时输入的新消息会进入队列，回到 idle 后自动发送；发送前用户可以丢弃。草稿为空时仍提供中断。
- Goal 和 Plan 是与 Terminal 一致的显式 Composer 请求模式。Provider Session 的 mode、model、reasoning、speed 等 runtime 设置，仍只展示 Agent 实际宣告的 ACP mode 或 config option。
- Context window 百分比需要已用 token 和最大 token。Codex 有精确 provider-session token event 时显示百分比；只提供累计 usage 的 ACP Agent 仍只显示 token 数。
- Composer 已支持原生 ACP image block；音频和任意 resource block 还没有开放。

## 权限与失败行为

`full` 权限模式会自动选择 Agent 提供的 allow 选项；`ask` 会自动选择 reject 选项；普通审批模式会暴露完整的 ACP permission request，并等待后端 API 的明确回答。

ACP 启动、初始化、历史恢复、prompt、协议和 adapter 退出错误都会成为明确的 runtime error。Farming 不会把用户指定的 ACP Agent 静默降级成 Terminal 或 JSON CLI。

## 后端 API

- `GET /api/agents/:agentId/acp-session` 返回归一化 Session 和协商出的 capability。只有协议调试需要 raw ACP update 时才添加 `?includeUpdates=1`。
- `GET /api/agents/:agentId/acp-transcript?maxTurns=N` 为现有 Chat UI 返回 canonical entry stream 的脱敏视图投影。
- `GET /api/agents/:agentId/acp-sessions` 通过当前 provider 连接调用 ACP Session 列表。
- `POST /api/agents/:agentId/acp-permission` 回答待处理的 permission request。
- WebSocket `start-agent` 接受 `agentRuntimeMode: "acp"`，以及可选的 `acpHistoryMode: "load" | "resume"`。
- WebSocket `acp-permission-response` 不经过 HTTP，也能回答同一条权限流程。

Farming Code 中 Codex、Claude Code 和 OpenCode 的 Chat 控件现在默认选择 ACP。Chat 与 Terminal 之间切换会重启 Agent runtime，并恢复同一个 provider Session；旧 JSON Chat Session 仍然可以读取，但不再作为新 Chat 的启动入口。

Terminal 模式继续使用 `NativeSessionEngine`。ACP 是新启动或重启 Agent 时选择的结构化 runtime，不会同时复制一份 Terminal 进程。

## 验证

`backend/tests/test-acp-runtime.js` 会运行一个真实官方 SDK client 和确定性的假 ACP 子进程，验证新 Session、load 完整历史重放、prompt、权限选择、稳定 tool update、Session 列表和归一化 Session snapshot。
