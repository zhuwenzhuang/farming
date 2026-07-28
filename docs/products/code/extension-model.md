# Farming Code Extension Model

> Chinese version: [extension-model.zh_cn.md](./extension-model.zh_cn.md)

Status: the internal Viewer foundation and agent-browser-backed Browser Resource MVP are implemented; this is not yet a public third-party extension API.

## Implemented Foundation

Project Files now resolves built-in Markdown, SVG, and HTML viewers through one internal Viewer Registry. This establishes the first narrow Extension boundary without introducing package installation, dynamic third-party code, or a second editor framework.

The static HTML viewer uses the existing file tab and Source / Preview interaction. A bounded in-memory Preview Session authorizes resources under the selected project root and serves them through Farming's existing authenticated HTTP service, so it opens no additional listening port. The browser renders the current unsaved draft in a sandboxed iframe, disables scripts, form submission, nested frames, and active network APIs, and resolves only authorized relative static assets through that Preview Session. Relative HTML navigation stays inside the same Session, including workspace-root-relative assets on the destination page. Closing the viewer deletes its session; expiration and capacity limits bound abandoned sessions.

An explicitly opened readable file outside known project roots remains read-only. For exact external HTML preview, the temporary Preview Session authorizes only the HTML file's containing directory so its relative assets can load; it does not add that directory to Files browsing, search, editing, or Git scope.

The Browser Extension is the first live Resource implementation. Its integration is disabled by default, and Agent tool and MCP attachment remain on demand. It can either launch an installed system Chromium or connect to an explicitly configured external CDP endpoint. The Plugins view names the available source and disables its enable action when neither exists. Only an enabled and currently available Extension contributes Browser UI or accepts Browser API, EventSource, Viewer WebSocket, CLI, or MCP operations.

Each Project may own multiple stable, renameable Browser rows with an explicit `stopped -> starting -> running -> stopping -> stopped` lifecycle; startup or runtime failure ends in `failed`. System-browser rows own an isolated profile and their agent-browser Session. External-CDP rows own only the page targets they create; the external owner retains the browser process, container, image, profile, and endpoint. Operations are serialized per Browser identity, stale Viewer generations are rejected, and a Farming restart marks previously live rows failed. Every persisted mutation increments both the row revision and a collection revision. The backend registers live event listeners before emitting the authoritative collection snapshot, and the UI reduces HTTP, EventSource, and Viewer updates by those revisions so delayed transport delivery cannot regress or remove newer state.

Both sources use the same exact, version-locked `agent-browser` runtime. Before the Server opens its port, startup preparation always downloads and verifies the pinned platform artifact into Farming's immutable cache; a system `agent-browser` installation is never reused. The user selects a discovered system Chromium or an external loopback CDP endpoint in **Plugins → Browser**; source selection is ordinary persisted product configuration and does not require restarting Farming. For a local Resource, Farming gives the selected Chromium executable and isolated profile to that managed runtime; there is no separate Farming Chromium launcher. For an external Resource, the same runtime connects to the configured loopback endpoint and creates one labeled tab. Farming does not access Docker, manage containers, or ship Chromium.

The authenticated Viewer proxies the runtime's session-scoped WebSocket stream. Frames are JPEG to keep interaction responsive, while viewport, pointer, wheel, keyboard, and text input return through the same Session. The Viewer paints at the frame's reported CSS dimensions and discards superseded frames when a client is slow. Agent commands and human input therefore operate the same Browser identity without Farming carrying a second raw-CDP action path.

Farming does not auto-mount Browser MCP into ACP Sessions. Codex, Claude Code, OpenCode, and Qoder receive a small Farming startup bootstrap at process or Session creation time, without modifying the Project or provider-owned instruction files. The bootstrap tells the Agent to query `farming capabilities` instead of assuming a capability exists. When Browser is available, the Agent can list, create, start, attach and operate Project-owned Browser Resources on demand through `farming browser`; `farming-browser` remains the npm bin alias. `farming browser mcp` is an explicit stdio bridge for a caller that intentionally configures MCP at a Session boundary, not a default attachment.

Farming Code should be able to grow through Extensions instead of adding every new resource and Agent capability directly to the core product. A browser is the motivating example, but it should not become a one-off browser subsystem.

Farming Code exposes these capabilities through one Plugins view. A compact puzzle button in the top-left navigation and a large Plugins action on the empty welcome surface open that same view. Plugin lifecycle and configuration belong there rather than in general Settings. Opening the Plugins view is read-only; enabling or disabling a plugin remains an explicit action.

## Resource And Viewer Model

An Extension may contribute a typed resource and one or more viewers for that resource. Farming owns the surrounding workspace, tab and layout behavior; the Extension owns the resource-specific rendering and lifecycle semantics.

Files already demonstrate the underlying idea: text, Markdown, images, PDFs, diffs and other file types use different viewers while keeping one workspace context. A browser can follow the same model as a live hypertext resource. Its viewer may display a local or remote page, but Farming should treat it as another openable surface rather than hard-code browser behavior throughout the Agent and file UI.

An Extension package may eventually contribute:

- resource types and stable resource identities;
- viewers, commands and contextual actions;
- a backend runtime or connection adapter when the resource is live;
- Agent tools and the guidance required to use them;
- capability, permission and health metadata.

Built-in Extensions and externally installed Extensions should use the same contract. Being built in should affect distribution and trust defaults, not create a second integration architecture.

## Agent Capability Projection

Extensions should publish Agent-facing tools through one Farming-owned capability contract. An Extension must not implement separate Codex, Claude, OpenCode and Qoder integrations.

When Farming starts or resumes an Agent, it injects only the short Farming bootstrap through the Provider Adapter at the process or Session boundary. Live availability remains outside the prompt: `farming capabilities` reports whether Browser is disabled, unavailable, or available and, when available, gives the commands for using it on demand. This avoids paying MCP startup, schema-context and stability cost in every ACP Session. A user or Agent may still explicitly add the standard `farming browser mcp` stdio server when its tool schemas are useful. Tool identity, schema, ownership, permission policy and result semantics remain defined by Farming's Extension contract.

The intended relationship is:

```text
Extension runtime and viewer
          |
          | Farming Extension contract
          v
Farming resource UI + Agent capability registry
          |
          | startup bootstrap + on-demand CLI or explicit MCP
          v
Codex / Claude / OpenCode / Qoder
```

Agents may still have native or user-installed tools of their own. Farming does not silently replace those tools. Tool ownership and name collisions must be explicit, and the active Agent must be able to discover which capabilities are supplied by Farming and which are provider-native.

## Browser As An Extension

Farming's Browser Extension owns one Browser Resource identity and the page target shown by its Viewer and Agent tools. With a system browser it also owns the isolated profile and local agent-browser Session. With external CDP it owns only its created target and connection, never the externally managed browser lifecycle.

The MVP intentionally uses one operations implementation: the pinned `agent-browser` command and stream protocols, reached through a local system-browser executable or external-CDP connection. It does not expose the browser's native window chrome, extensions, download UI, DevTools, arbitrary desktop interaction or Computer Use. Those are separate product capabilities rather than hidden fallback paths.

Each Browser has a durable unique id, belongs to one Project workspace, and may be opened directly with the `browser` URL query parameter. Deleting a system-browser row stops its exact runtime before removing its isolated profile. Deleting an external-CDP row closes only Farming-created targets.

## Open Design Questions

The first implementation must resolve these before the Extension API is treated as stable:

- whether future live resource types also default to Project ownership or need Agent and explicitly shared scopes;
- how tool-name collisions and provider-native equivalents are surfaced;
- how Extension UI is isolated and authorized inside the Farming page;
- which lifecycle and recovery guarantees Farming core requires from a live Extension runtime.

The architectural constraint is already clear: resource presentation and Agent tools belong to one Extension, while Provider-specific translation stays at the existing Provider Adapter boundary.
