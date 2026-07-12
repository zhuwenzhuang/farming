# JSON Chat Runtime

[简体中文](./json-chat-runtime.zh_cn.md)

The JSON CLI runtime is retained for compatibility with existing Codex and OpenCode Chat sessions. New Chat launches and the Chat / Terminal switch use ACP instead.

- Codex uses `codex exec --json` and resumes with `codex exec resume --json <session-id>`.
- OpenCode uses `opencode run --format json` and resumes with `--session <session-id>`.
- JSONL stdout is normalized into the existing Chat turn model. Tool and reasoning items remain secondary to the user message and final answer.
- The top-right Chat / Terminal control now switches between ACP and Terminal. It no longer starts JSON CLI mode.
- Existing JSON transcript events are carried across a live runtime replacement. Provider history import and server-restart recovery remain separate history concerns.

The regular Terminal runtime remains the fallback for unsupported agents and direct TUI interaction. App Server remains available as a separate experimental Codex runtime.
