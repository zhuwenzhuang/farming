# ACP 后端 Runtime

> English version: [acp-runtime.md](./acp-runtime.md)

Farming 现在提供一条面向 Codex、Claude Code 和 OpenCode 的 Agent Client Protocol runtime。后端生命周期与前端展示刻意分离：后端负责 Agent 进程、ACP Session 生命周期、统一状态和控制 API，`src/components/code/acp/` 则只描述 ACP Chat 行为。

## Provider 连接

- Codex 使用锁定版本的 `@agentclientprotocol/codex-acp` adapter。
- Claude Code 使用锁定版本的 `@agentclientprotocol/claude-agent-acp` adapter。
- OpenCode 使用自身的 `opencode acp --cwd <workspace>` 命令。
- 三者都通过官方 `@agentclientprotocol/sdk`，在子进程 stdio 上使用按行分隔的 JSON-RPC 通信。

Adapter 包使用精确版本的 production dependency。Farming 启动 Agent 时不会执行 `npx latest`。

## Session 语义

只要 Agent 声明对应 capability，runtime 就支持 ACP 的 `initialize`、`session/new`、`session/load`、`session/resume`、`session/list`、`session/fork`、`session/delete`、`session/close`、`session/set_mode`、`session/set_config_option`、`session/prompt` 和 `session/cancel`。

已有历史 Session 默认使用 `session/load`。这是因为 ACP load 会在请求返回之前，通过 `session/update` notification 重放完整对话；显式 `resume` 只恢复上下文，不重放旧消息。Farming 会先注册 Session reducer，再发出 load，确保不会漏掉提前到达的历史 notification。

ACP update 一方面以有界 raw 数据保留，另一方面归约到一条与 provider 无关的有序 entry stream。历史重放和实时更新使用同一个 reducer；相邻且 message id 兼容的 message chunk 合并，tool update 按 id 原位更新最初的 tool-call entry，plan entry 原位更新。usage、mode、command 和 config option 等 Session 元数据不混入对话流。runtime notification 只携带轻量失效信息，避免历史重放时反复复制不断增长的 transcript。

## Farming Code 展示

ACP 在 `src/components/code/acp/` 下拥有独立的 composer、草稿命名空间、权限卡片、Session 控件、动态命令菜单和 transcript adapter。Terminal 继续使用 `CodeComposer` 与 PTY 输入路径，不加入 ACP 分支。

Composer 展示当前 ACP Session 协商出的 mode、model、reasoning、boolean option、usage 和 available commands。ACP transcript 直接消费有序 entries，不再重建 provider-specific turn。注意力投影把可见用户消息之后的最后一条 assistant entry 作为结果，把此前的 commentary、thought、tool 和 plan 按原顺序收入一个可逆的“执行过程”折叠区。Tool 的 raw input/output、diff、terminal 和 location 在折叠区内仍可逐项展开。Codex 内部 context 与 heartbeat 活动按 segment 隐藏，但真正需要通知用户的 automation 结果仍作为 assistant message 保留。

## 权限与失败行为

`full` 权限模式会自动选择 Agent 提供的 allow 选项；`ask` 会自动选择 reject 选项；普通审批模式会暴露完整的 ACP permission request，并等待后端 API 的明确回答。

ACP 启动、初始化、历史恢复、prompt、协议和 adapter 退出错误都会成为明确的 runtime error。Farming 不会把用户指定的 ACP Agent 静默降级成 Terminal 或 JSON CLI。

## 后端 API

- `GET /api/agents/:agentId/acp-session` 返回归一化 Session 和协商出的 capability。只有协议调试需要 raw ACP update 时才添加 `?includeUpdates=1`。
- `GET /api/agents/:agentId/acp-transcript?maxEntries=N` 为 ACP 独立 Chat UI 返回 canonical entry stream 的脱敏分页投影。
- `GET /api/agents/:agentId/acp-sessions` 通过当前 provider 连接调用 ACP Session 列表。
- `POST /api/agents/:agentId/acp-permission` 回答待处理的 permission request。
- WebSocket `start-agent` 接受 `agentRuntimeMode: "acp"`，以及可选的 `acpHistoryMode: "load" | "resume"`。
- WebSocket `acp-permission-response` 不经过 HTTP，也能回答同一条权限流程。

Farming Code 中 Codex、Claude Code 和 OpenCode 的 Chat 控件现在默认选择 ACP。Chat 与 Terminal 之间切换会重启 Agent runtime，并恢复同一个 provider Session；旧 JSON Chat Session 仍然可以读取，但不再作为新 Chat 的启动入口。

Terminal 模式继续使用 `NativeSessionEngine`。ACP 是新启动或重启 Agent 时选择的结构化 runtime，不会同时复制一份 Terminal 进程。

## 验证

`backend/tests/test-acp-runtime.js` 会运行一个真实官方 SDK client 和确定性的假 ACP 子进程，验证新 Session、load 完整历史重放、prompt、权限选择、稳定 tool update、Session 列表和归一化 Session snapshot。
