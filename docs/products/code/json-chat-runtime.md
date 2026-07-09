# JSON Chat Runtime

[简体中文](./json-chat-runtime.zh_cn.md)

Farming Code can launch Codex and OpenCode turns through their structured JSON CLI modes. This runtime is experimental and exists alongside the Codex App Server experiment and the regular interactive terminal runtime.

- Codex uses `codex exec --json` and resumes with `codex exec resume --json <session-id>`.
- OpenCode uses `opencode run --format json` and resumes with `--session <session-id>`.
- JSONL stdout is normalized into the existing Chat turn model. Tool and reasoning items remain secondary to the user message and final answer.
- The top-right Chat / Terminal control switches runtimes. Switching stops the current runtime, starts the other command, and resumes the same provider session. It is not a view-only toggle.
- Existing JSON transcript events are carried across a live runtime replacement. Provider history import and server-restart recovery remain separate history concerns.

The regular Terminal runtime remains the fallback for unsupported agents and direct TUI interaction. App Server remains available as a separate experimental Codex runtime.
