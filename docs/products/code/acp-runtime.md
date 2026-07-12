# ACP Backend Runtime

> Chinese version: [acp-runtime.zh_cn.md](./acp-runtime.zh_cn.md)

Farming has an Agent Client Protocol runtime for Codex, Claude Code, OpenCode, and Qoder. Backend lifecycle and frontend presentation remain intentionally separate: the backend owns the Agent process, ACP session lifecycle, normalized state, and control APIs, while `src/components/code/acp/` owns ACP-only Chat behavior.

## Provider Connections

- Codex uses the pinned `@agentclientprotocol/codex-acp` adapter.
- Claude Code uses the pinned `@agentclientprotocol/claude-agent-acp` adapter.
- OpenCode uses its native `opencode acp --cwd <workspace>` command.
- Qoder uses its native `qodercli --acp` command. Qoder can emit the tail of a loaded history after `session/load` returns, so Farming waits for the replay stream to settle before exposing the restored session.
- All three communicate through the official `@agentclientprotocol/sdk` over newline-delimited JSON-RPC on subprocess stdio.

Adapter package versions are exact production dependencies. Farming does not run `npx latest` during Agent startup.

## Session Semantics

The runtime supports ACP `initialize`, `session/new`, `session/load`, `session/resume`, `session/list`, `session/fork`, `session/delete`, `session/close`, `session/set_mode`, `session/set_config_option`, `session/prompt`, and `session/cancel` when the Agent advertises the corresponding capability.

An existing history session uses `session/load` by default. This matters because ACP load replays the complete conversation through `session/update` notifications before the load request returns. Explicit `resume` reconnects the context without replaying old messages. Farming registers the session reducer before sending load so early replay notifications cannot be lost.

ACP updates are retained in bounded raw form and reduced into one provider-neutral ordered entry stream. History replay and live updates use the same reducer. Adjacent compatible message chunks merge by message id, tool updates mutate the original tool-call entry by id, and plan entries update in place. Session metadata such as usage, modes, commands, and config options stays outside the conversation stream. Runtime notifications carry only lightweight invalidation metadata so history replay does not repeatedly clone a growing transcript.

## Farming Code Presentation

ACP uses its own composer, draft namespace, permission cards, session controls, dynamic command menu, and transcript adapter under `src/components/code/acp/`. Terminal continues to use `CodeComposer` and the PTY input path without ACP branches.

The composer renders the modes, model, reasoning level, boolean options, usage, and available commands negotiated from the live ACP session. The existing Chat UI design is preserved: an adapter projects the canonical ordered entries into its user/result/process view model without changing the composer or transcript component hierarchy. The projection keeps the last assistant entry following a visible user message as the result and folds preceding commentary, thoughts, tools, and plans into the existing reversible process disclosure. A tool update containing ACP `diff` blocks is also projected as the existing file-change result card, which opens the workspace's current Review page. Tool details, raw input/output, compact contextual patches, terminals, and locations remain expandable. ACP transcript refreshes follow session update signals from the shared state websocket instead of repeatedly downloading an unchanged idle history. Internal Codex context and heartbeat activity is hidden as a segment, while a visible automation notification remains an assistant message.

The ACP composer preserves the ordinary message-box behavior that does not depend on PTY input: drafts and history navigation, Enter/Shift+Enter and IME handling, file selection, pasted image previews, attachment removal, voice dictation, provider commands, interrupt, and provider permission/configuration controls. Text files are embedded in the message and uploaded images are passed by their Farming-local path, matching the existing composer representation.

ACP boundaries remain explicit:

- ACP has no concurrent prompt/steer operation. While a turn is running, the composer offers interrupt and preserves the draft; the draft can be sent after the Agent returns to idle.
- Goal/Plan, model, reasoning, speed, and other settings are shown only when the provider advertises the corresponding ACP mode or config option. Farming does not synthesize provider settings.
- A context-window percentage needs both used and maximum tokens. ACP providers that expose only cumulative usage get a token count rather than the Terminal composer's percentage ring.
- Attachments currently use the established text/local-path message representation. Farming does not claim native ACP binary image, audio, or arbitrary resource-block transport until the provider and adapter negotiate it end to end.

## Permissions And Failure Behavior

`full` permission mode selects an advertised allow option automatically. `ask` selects an advertised reject option. The normal approval mode exposes the full pending ACP permission request and waits for an explicit response through the backend API.

ACP startup, initialization, history restoration, prompt, protocol, and adapter-exit failures are reported as runtime errors. Farming does not silently replace a requested ACP Agent with Terminal or JSON CLI mode.

## Backend API

- `GET /api/agents/:agentId/acp-session` returns the normalized session and negotiated capabilities. Add `?includeUpdates=1` only for protocol debugging when the bounded raw ACP update stream is required.
- `GET /api/agents/:agentId/acp-transcript?maxTurns=N` returns a sanitized view projection of the canonical entry stream for the existing Chat UI.
- `GET /api/agents/:agentId/acp-sessions` calls ACP session listing for the live provider connection.
- `POST /api/agents/:agentId/acp-permission` answers a pending permission request.
- WebSocket `start-agent` accepts `agentRuntimeMode: "acp"` and optional `acpHistoryMode: "load" | "resume"`.
- WebSocket `acp-permission-response` answers the same permission flow without HTTP.

Farming Code's Chat control now selects ACP for Codex, Claude Code, and OpenCode. Switching between Chat and Terminal restarts the Agent runtime and resumes the same provider session; legacy JSON Chat sessions remain readable but are no longer the new Chat launch path.

Terminal mode continues to use `NativeSessionEngine`. ACP is a structured runtime selected for a newly launched or restarted Agent; it does not duplicate a Terminal process.

## Verification

`backend/tests/test-acp-runtime.js` runs an actual official-SDK client and a deterministic fake ACP subprocess. It verifies new sessions, full history replay during load, prompting, permission selection, stable tool updates, session listing, and the normalized session snapshot.
