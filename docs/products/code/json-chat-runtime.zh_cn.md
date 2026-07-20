# JSON Chat Runtime

[English](./json-chat-runtime.md)

JSON CLI runtime 只保留用于兼容已有的 Codex 和 OpenCode Chat Session。新的 Chat 启动和 Chat / Terminal 切换统一使用 ACP。

- Codex 使用 `codex exec --json`，续聊使用 `codex exec resume --json <session-id>`。
- OpenCode 使用 `opencode run --format json`，续聊增加 `--session <session-id>`。
- JSONL stdout 会被规范化为现有 Chat turn 模型；tool 和 reasoning 默认处于用户问题与最终回答之后的次要层级。
- 右上角 Chat / Terminal 控件现在在 ACP 与 Terminal 之间切换，不再启动 JSON CLI runtime。
- 当前 JSON transcript events 会随一次在线 runtime replacement 保留。Provider 历史导入和服务重启恢复属于后续独立的历史能力。

普通 Terminal runtime 继续作为不支持结构化输出的 Agent 和直接操作 TUI 时的兜底。Codex 结构化 Chat 只使用 ACP。
