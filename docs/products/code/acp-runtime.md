# ACP Backend Runtime

> Chinese version: [acp-runtime.zh_cn.md](./acp-runtime.zh_cn.md)

Farming has an Agent Client Protocol runtime for Codex, Claude Code, and OpenCode. Backend lifecycle and frontend presentation remain intentionally separate: the backend owns the Agent process, ACP session lifecycle, normalized state, and control APIs, while `src/components/code/acp/` owns ACP-only Chat behavior.

## Provider Connections

- Codex uses the pinned `@agentclientprotocol/codex-acp` adapter.
- Claude Code uses the pinned `@agentclientprotocol/claude-agent-acp` adapter.
- OpenCode uses its native `opencode acp --cwd <workspace>` command.
- All three communicate through the official `@agentclientprotocol/sdk` over newline-delimited JSON-RPC on subprocess stdio.

Adapter package versions are exact production dependencies. Farming does not run `npx latest` during Agent startup.

## Session Semantics

The runtime supports ACP `initialize`, `session/new`, `session/load`, `session/resume`, `session/list`, `session/fork`, `session/delete`, `session/close`, `session/set_mode`, `session/set_config_option`, `session/prompt`, and `session/cancel` when the Agent advertises the corresponding capability.

An existing history session uses `session/load` by default. This matters because ACP load replays the complete conversation through `session/update` notifications before the load request returns. Explicit `resume` reconnects the context without replaying old messages. Farming registers the session reducer before sending load so early replay notifications cannot be lost.

ACP updates are retained in bounded raw form and reduced into one provider-neutral ordered entry stream. History replay and live updates use the same reducer. Adjacent compatible message chunks merge by message id, tool updates mutate the original tool-call entry by id, and plan entries update in place. Session metadata such as usage, modes, commands, and config options stays outside the conversation stream. Runtime notifications carry only lightweight invalidation metadata so history replay does not repeatedly clone a growing transcript.

## Farming Code Presentation

ACP uses its own composer, draft namespace, permission cards, session controls, dynamic command menu, and transcript adapter under `src/components/code/acp/`. Terminal continues to use `CodeComposer` and the PTY input path without ACP branches.

The composer renders the modes, model, reasoning level, boolean options, usage, and available commands negotiated from the live ACP session. The ACP transcript consumes ordered entries directly instead of rebuilding provider-specific turns. Its attention projection keeps the last assistant entry following a visible user message as the result and folds preceding commentary, thoughts, tools, and plans into one reversible process disclosure. Tool details, raw input/output, diffs, terminals, and locations remain individually expandable inside that disclosure. Internal Codex context and heartbeat activity is hidden as a segment, while a visible automation notification remains an assistant message.

## Permissions And Failure Behavior

`full` permission mode selects an advertised allow option automatically. `ask` selects an advertised reject option. The normal approval mode exposes the full pending ACP permission request and waits for an explicit response through the backend API.

ACP startup, initialization, history restoration, prompt, protocol, and adapter-exit failures are reported as runtime errors. Farming does not silently replace a requested ACP Agent with Terminal or JSON CLI mode.

## Backend API

- `GET /api/agents/:agentId/acp-session` returns the normalized session and negotiated capabilities. Add `?includeUpdates=1` only for protocol debugging when the bounded raw ACP update stream is required.
- `GET /api/agents/:agentId/acp-transcript?maxEntries=N` returns a sanitized, paged projection of the canonical entry stream for the ACP-only Chat UI.
- `GET /api/agents/:agentId/acp-sessions` calls ACP session listing for the live provider connection.
- `POST /api/agents/:agentId/acp-permission` answers a pending permission request.
- WebSocket `start-agent` accepts `agentRuntimeMode: "acp"` and optional `acpHistoryMode: "load" | "resume"`.
- WebSocket `acp-permission-response` answers the same permission flow without HTTP.

Farming Code's Chat control now selects ACP for Codex, Claude Code, and OpenCode. Switching between Chat and Terminal restarts the Agent runtime and resumes the same provider session; legacy JSON Chat sessions remain readable but are no longer the new Chat launch path.

Terminal mode continues to use `NativeSessionEngine`. ACP is a structured runtime selected for a newly launched or restarted Agent; it does not duplicate a Terminal process.

## Verification

`backend/tests/test-acp-runtime.js` runs an actual official-SDK client and a deterministic fake ACP subprocess. It verifies new sessions, full history replay during load, prompting, permission selection, stable tool updates, session listing, and the normalized session snapshot.
