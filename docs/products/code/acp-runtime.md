# ACP Backend Runtime

> Chinese version: [acp-runtime.zh_cn.md](./acp-runtime.zh_cn.md)

Farming has an Agent Client Protocol runtime for Codex, Claude Code, OpenCode, and Qoder. Backend lifecycle and frontend presentation remain intentionally separate: the backend owns the Agent process, ACP session lifecycle, normalized state, and control APIs, while `src/components/code/acp/` owns ACP-only Chat behavior.

## Provider Connections

- Codex uses the pinned `@agentclientprotocol/codex-acp` adapter.
- Claude Code uses the pinned `@agentclientprotocol/claude-agent-acp` adapter.
- OpenCode uses its native `opencode acp --cwd <workspace>` command.
- Qoder uses its native `qodercli --acp` command. Qoder can emit the tail of a loaded history after `session/load` returns, so Farming waits for the replay stream to settle before exposing the restored session.
- All four communicate through the official `@agentclientprotocol/sdk` over newline-delimited JSON-RPC on subprocess stdio.

Adapter package versions are exact production dependencies. Farming does not run `npx latest` during Agent startup.

## Session Semantics

The runtime supports ACP `initialize`, `session/new`, `session/load`, `session/resume`, `session/list`, `session/fork`, `session/delete`, `session/close`, `session/set_mode`, `session/set_config_option`, `session/prompt`, and `session/cancel` when the Agent advertises the corresponding capability.

An existing history session uses `session/load` by default. This matters because ACP load replays the complete conversation through `session/update` notifications before the load request returns. Explicit `resume` reconnects the context without replaying old messages. Farming registers the session reducer before sending load so early replay notifications cannot be lost.

History discovery keeps the full supported metadata window in the backend cache and sends Farming Code bounded cursor pages. Scrolling near the bottom of the project list loads the next page; project-level “Show more” still controls only local presentation within the pages already loaded. Agent Search queries that full backend window instead of filtering only the pages already loaded in the browser. Matching is case-insensitive and intentionally limited to visible Agent or session titles plus Project names and paths; provider metadata, session ids, and transcript content are not searched yet. Backend-returned session identities are authoritative search matches so the scope can expand later without being discarded by a second frontend title filter. History resume resolves provider metadata across the full backend window so an older session keeps its original workspace when it moves between Terminal and Chat. Qoder discovery treats only project-level transcript files as sessions; nested child-agent transcripts are replay details, not duplicate history rows.

ACP updates are retained in bounded, size-limited diagnostic form and reduced into one provider-neutral ordered entry stream. History replay and live updates use the same reducer. Adjacent compatible message chunks merge by message id, tool updates mutate the original tool-call entry by id, and plan entries update in place. Session metadata such as usage, modes, commands, and config options stays outside the conversation stream. Runtime notifications carry only lightweight invalidation metadata. Transcript reads use a monotonic revision and replace only the affected entry suffix, so a streaming response does not repeatedly clone, project, and transfer the complete history.

## Farming Code Presentation

ACP uses its own composer, draft namespace, permission cards, session controls, dynamic command menu, and transcript adapter under `src/components/code/acp/`. Terminal continues to use `CodeComposer` and the PTY input path without ACP branches. ACP client terminals use an embedded xterm view for real keystrokes, selection, output, resize, and stop behavior; this component is not shared with the Terminal page.

The composer renders the modes, model, reasoning level, boolean options, usage, and available commands negotiated from the live ACP session. The existing Chat UI design is preserved: an adapter projects the canonical ordered entries into its user/result/process view model without changing the composer or transcript component hierarchy. The projection keeps the last assistant entry following a visible user message as the result and folds preceding commentary, thoughts, tools, and plans into the existing reversible process disclosure. During an active turn, that disclosure opens by default and preserves the ACP order as readable progress prose interleaved with compact action summaries; only the latest streaming thought opens automatically, and it folds again when the turn completes. The user can close it while work continues. When the turn completes, the process collapses again so the final result regains focus. A tool update containing ACP `diff` blocks is projected as a file-change result card without flattening away the protocol data: the collapsed card shows deduplicated paths and line totals, its first expansion lists the affected files, and each file can reveal the exact historical ACP patch on demand. The separate Review action captures only paths inside the Agent workspace instead of opening an unrelated whole-workspace change set; out-of-workspace patches remain inspectable inline. Tool details, raw input/output, compact contextual patches, terminals, and locations remain expandable. ACP child sessions remain nested under their parent tool entry; the preview can be opened in a focused dialog, a running child can be stopped independently, and child permissions or elicitation forms are answered through the parent Chat controls. Large details are omitted from the transcript page and fetched by tool-call id only when the user expands or copies that item. The ACP Chat view initially projects 20 turns and loads older turns in 20-turn pages as the user scrolls upward. ACP transcript refreshes follow session update signals from the shared state websocket and request only the changed suffix. Internal Codex context and heartbeat activity is hidden as a segment, while a visible automation notification remains an assistant message.

The ACP composer preserves the ordinary message-box behavior that does not depend on PTY input: drafts and history navigation, Enter/Shift+Enter and IME handling, file selection, pasted image previews, attachment removal, voice dictation, provider commands and skills, Goal/Plan request modes, queued follow-ups, interrupt, context-window usage when exact Codex data is available, and provider permission/configuration controls. The `+` menu contains attachment, Goal, and Plan actions; provider commands remain searchable through `/`, while `$` opens the provider-advertised skill subset. Uploaded images travel as native ACP image content blocks. Text files remain embedded in the message, and unavailable image uploads retain the existing textual fallback.

For Codex, Farming maps the selected launch profile into the ACP adapter's `CODEX_CONFIG` and `INITIAL_AGENT_MODE`. Switching between Terminal and Chat therefore preserves model, reasoning effort, service tier, and the matching initial permission mode instead of silently reverting to adapter defaults.

Changing a Codex model in a live ACP session first lets the adapter choose a compatible reasoning fallback, then refreshes the adapter's model catalog and reapplies the standard config option. This keeps model-specific capabilities such as Fast mode truthful even when a long-lived session was opened before the provider or proxy refreshed its model metadata. Related model and reasoning changes can be applied as one profile update. For model families that expose Sol, Terra, and Luna variants, the composer presents one continuous draggable surface for variant and ordinary reasoning selection, a click-operated red Ultra rocker that automatically pulls down when enabled, and a separate `Fast OFF` / `Fast ON` speed button. **Advanced** morphs back to the exact step-by-step reasoning, model, and speed controls without resetting the selected profile. Controls update the Composer optimistically while the negotiated ACP request is pending, reconcile with the returned session snapshot, and roll back if the request fails. The Ultra and Fast positions remain stable while capabilities refresh; a control that the live session does not advertise stays visible, grey, and disabled instead of making the menu jump.

The same controls also update a live native Codex Terminal instead of changing only its next launch profile. Farming stages the CLI's interactive `/model` selection and version-compatible `/fast` toggle before the next Composer message, then submits that message after the controls have been applied. New Terminals receive an explicit `service_tier="default"` when Standard is selected, so a Fast value in the user's Codex config cannot make the runtime disagree with Farming's control. The launch profile is persisted at the same time so a restarted Agent remains consistent. These PTY commands are never injected into ACP, legacy JSON, App Server, shell, Claude, OpenCode, Qoder, or other non-Codex Terminal sessions.

ACP boundaries remain explicit:

- ACP has no concurrent prompt/steer operation. A message entered during a running turn is queued and sent when the Agent returns to idle; the user may discard it before then. Interrupt remains available when the draft is empty.
- Goal and Plan are explicit composer request modes, matching Terminal behavior. Provider session modes, model, reasoning, speed, and other runtime settings are still shown only when the Agent advertises the corresponding ACP mode or config option.
- A context-window percentage needs both used and maximum tokens. Codex uses its exact provider-session token event when available; ACP providers that expose only cumulative usage get a token count instead.
- Native image blocks are supported. Audio and arbitrary resource blocks are not yet exposed by the composer.
- Editing an old prompt with a repository checkpoint and truncating later turns is not part of base ACP. Farming does not present that optional client-side capability as protocol support.

## Permissions And Failure Behavior

`full` permission mode selects an advertised allow option automatically. `ask` selects an advertised reject option. The normal approval mode exposes the full pending ACP permission request and waits for an explicit response through the backend API.

ACP startup, initialization, history restoration, prompt, protocol, and adapter-exit failures are reported as runtime errors. Bounded control requests fail with actionable timeouts; a normal long-running prompt is not assigned an artificial wall-clock timeout. Farming does not silently replace a requested ACP Agent with Terminal or JSON CLI mode. Chat / Terminal switching is rejected while a turn is active. A new Terminal with no user input may start a fresh ACP session when provider history has not been materialized yet; after Terminal input, the switch requires the saved session to remain discoverable. After the turn is idle, the switch stops the old process and starts the requested runtime; if that startup fails, Farming immediately resumes the same provider session in the original runtime and reports the failed switch.

## Backend API

- `GET /api/agents/:agentId/acp-session` returns the normalized session and negotiated capabilities. Add `?includeEntries=0` for the lightweight controls/usage snapshot. Add `?includeUpdates=1` only for protocol debugging when the bounded raw ACP update stream is required.
- `GET /api/agents/:agentId/acp-transcript?maxTurns=N` returns a sanitized view projection of the canonical entry stream for the existing Chat UI. Live readers add `sinceRevision=R` to receive only the affected suffix.
- `GET /api/agents/:agentId/acp-tool-details/:toolCallId` loads expandable tool detail and exact structured ACP patches on demand.
- `GET /api/agents/:agentId/acp-sessions` calls ACP session listing for the live provider connection.
- `PATCH /api/agents/:agentId/acp-session` changes one negotiated mode/config option, or accepts `configOptions` for an atomic model-and-reasoning profile change.
- `POST /api/agents/:agentId/acp-permission` answers a pending permission request.
- `POST /api/agents/:agentId/acp-terminals/:terminalId/input|resize|kill` controls an ACP client terminal.
- `POST /api/agents/:agentId/acp-subagents/:sessionId/cancel` stops a known ACP child session without cancelling the parent session.
- WebSocket `start-agent` accepts `agentRuntimeMode: "acp"` and optional `acpHistoryMode: "load" | "resume"`.
- WebSocket `acp-permission-response` answers the same permission flow without HTTP.

Farming Code's Chat control now selects ACP for Codex, Claude Code, and OpenCode. Switching between Chat and Terminal restarts the Agent runtime and resumes the same provider session; legacy JSON Chat sessions remain readable but are no longer the new Chat launch path.

Terminal mode continues to use `NativeSessionEngine`. ACP is a structured runtime selected for a newly launched or restarted Agent; it does not duplicate a Terminal process.

## Verification

`backend/tests/test-acp-runtime.js` runs an actual official-SDK client and a deterministic fake ACP subprocess. It verifies new sessions, full history replay during load, prompting, permission selection, stable tool updates, session listing, and the normalized session snapshot.
