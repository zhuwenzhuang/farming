# JSON Chat Runtime

[English](./json-chat-runtime.md)

Farming Code 可以通过 Codex 和 OpenCode 的结构化 JSON CLI 模式执行 Chat turn。该 runtime 仍是实验性能力，与 Codex App Server 实验路径和普通交互式 Terminal runtime 并存。

- Codex 使用 `codex exec --json`，续聊使用 `codex exec resume --json <session-id>`。
- OpenCode 使用 `opencode run --format json`，续聊增加 `--session <session-id>`。
- JSONL stdout 会被规范化为现有 Chat turn 模型；tool 和 reasoning 默认处于用户问题与最终回答之后的次要层级。
- 右上角 Chat / Terminal 控件用于切换 runtime。切换会停止当前 runtime、启动另一条命令，并恢复同一个 provider session；它不是只切换画面的按钮。
- 当前 JSON transcript events 会随一次在线 runtime replacement 保留。Provider 历史导入和服务重启恢复属于后续独立的历史能力。

普通 Terminal runtime 继续作为不支持结构化输出的 Agent 和直接操作 TUI 时的兜底。App Server 仍作为独立的 Codex 实验性 runtime 保留。
