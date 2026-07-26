# Farming Code Extension Model

> Chinese version: [extension-model.zh_cn.md](./extension-model.zh_cn.md)

Status: the internal Viewer foundation and built-in Browser Resource MVP are implemented; this is not yet a public third-party extension API.

## Implemented Foundation

Project Files now resolves built-in Markdown, SVG, and HTML viewers through one internal Viewer Registry. This establishes the first narrow Extension boundary without introducing package installation, dynamic third-party code, or a second editor framework.

The static HTML viewer uses the existing file tab and Source / Preview interaction. A bounded in-memory Preview Session authorizes resources under the selected project root and serves them through Farming's existing authenticated HTTP service, so it opens no additional listening port. The browser renders the current unsaved draft in a sandboxed iframe, disables scripts, form submission, nested frames, and active network APIs, and resolves only authorized relative static assets through that Preview Session. Relative HTML navigation stays inside the same Session, including workspace-root-relative assets on the destination page. Closing the viewer deletes its session; expiration and capacity limits bound abandoned sessions.

An explicitly opened readable file outside known project roots remains read-only. For exact external HTML preview, the temporary Preview Session authorizes only the HTML file's containing directory so its relative assets can load; it does not add that directory to Files browsing, search, editing, or Git scope.

The built-in Browser Extension is the first live Resource implementation. Each Project may own multiple stable, renameable Browser rows. Every row has an isolated profile and an explicit `stopped -> starting -> running -> stopping -> stopped` lifecycle; startup or runtime failure ends in `failed`. Operations are serialized per Browser identity, stale Viewer generations are rejected, and a Farming restart marks previously live rows failed instead of guessing whether an unowned browser process is safe to reuse.

The Extension discovers a compatible system Chrome, Brave, Edge, or Chromium executable. It launches that executable headlessly and connects through raw CDP over WebSocket. Farming does not ship Chromium and the Extension has no Playwright or Puppeteer runtime dependency. `Page.startScreencast` supplies the authenticated in-workspace Viewer; Viewer pointer, wheel, keyboard and resize messages return through the same CDP target. Agent operations use the same target through accessibility snapshots, stable snapshot refs, screenshots, navigation and CDP input. `farming browser` is the initial Agent-facing bridge, with `farming-browser` retained as an npm-installed alias.

Farming Code should be able to grow through Extensions instead of adding every new resource and Agent capability directly to the core product. A browser is the motivating example, but it should not become a one-off browser subsystem.

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

When Farming starts or resumes an Agent, the enabled Extension capabilities for that Agent are projected through the Provider Adapter at the session boundary. The concrete transport may differ by provider, but tool identity, schema, ownership, permission policy and result semantics remain defined by Farming's Extension contract.

The intended relationship is:

```text
Extension runtime and viewer
          |
          | Farming Extension contract
          v
Farming resource UI + Agent capability registry
          |
          | Provider Adapter projection
          v
Codex / Claude / OpenCode / Qoder
```

Agents may still have native or user-installed tools of their own. Farming does not silently replace those tools. Tool ownership and name collisions must be explicit, and the active Agent must be able to discover which capabilities are supplied by Farming and which are provider-native.

## Browser As An Extension

The built-in Browser Extension owns a Browser Session, its profile and CDP endpoint. The Extension viewer displays that exact Session, while the Extension's Agent tools operate on the same identity. This lets a human observe or take over without requiring provider-specific browser code inside every Agent implementation.

The MVP intentionally uses one implementation: a system Chromium-family executable plus raw CDP and CDP Screencast. It does not expose the browser's native window chrome, extensions, download UI, DevTools, arbitrary desktop interaction or Computer Use. Those are separate product capabilities rather than hidden fallback paths.

Each Browser has a durable unique id, belongs to one Project workspace, and may be opened directly with the `browser` URL query parameter. Browser metadata and profiles live under the Farming config directory; deleting the row stops its exact runtime before removing its isolated profile.

## Open Design Questions

The first implementation must resolve these before the Extension API is treated as stable:

- how the current `farming browser` bridge should later project through MCP, an ACP/client-tool extension, or another Farming capability transport;
- whether future live resource types also default to Project ownership or need Agent and explicitly shared scopes;
- how tool-name collisions and provider-native equivalents are surfaced;
- how Extension UI is isolated and authorized inside the Farming page;
- which lifecycle and recovery guarantees Farming core requires from a live Extension runtime.

The architectural constraint is already clear: resource presentation and Agent tools belong to one Extension, while Provider-specific translation stays at the existing Provider Adapter boundary.
