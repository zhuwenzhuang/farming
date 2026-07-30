# Farming Code Extension Model

> Chinese version: [extension-model.zh_cn.md](./extension-model.zh_cn.md)

Status: the internal Viewer foundation and agent-browser-backed Browser Resource MVP are implemented; this is not yet a public third-party extension API.

## Implemented Foundation

Project Files now resolves built-in Markdown, SVG, and HTML viewers through one internal Viewer Registry. This establishes the first narrow Extension boundary without introducing package installation, dynamic third-party code, or a second editor framework.

The static HTML viewer uses the existing file tab and Source / Preview interaction. A bounded in-memory Preview Session authorizes resources under the selected project root and serves them through Farming's existing authenticated HTTP service, so it opens no additional listening port. The browser renders the current unsaved draft in a sandboxed iframe, disables scripts, form submission, nested frames, and active network APIs, and resolves only authorized relative static assets through that Preview Session. Relative HTML navigation stays inside the same Session, including workspace-root-relative assets on the destination page. Closing the viewer deletes its session; expiration and capacity limits bound abandoned sessions.

An explicitly opened readable file outside known project roots remains read-only. For exact external HTML preview, the temporary Preview Session authorizes only the HTML file's containing directory so its relative assets can load; it does not add that directory to Files browsing, search, editing, or Git scope.

The Browser Extension is the first live Resource implementation. Its integration is disabled by default. It can launch an installed system Chromium, launch an explicitly user-installed Farming-managed Chromium, or connect to an explicitly configured external CDP endpoint. The Plugins view names the available source and disables its enable action when none exists. Only an enabled and currently available Extension contributes Browser UI or accepts Browser API, EventSource, Viewer WebSocket, CLI, or MCP operations.

Each live Agent may own multiple stable, renameable Browser rows with an explicit `stopped -> starting -> running -> stopping -> stopped` lifecycle; startup or runtime failure ends in `failed`. The Project root remains the filesystem and upload/download boundary, but it is not the runtime owner. Running rows owned by the same Agent and using the same Browser source are labeled tabs in one shared agent-browser Session. Different Agents never share that Session, profile, cookies, or storage even when they belong to the same Project. A local Session owns its Chromium process and isolated profile; an external-CDP Session owns only its connection and created targets, while the external owner retains the browser process, container, image, profile, and endpoint. Operations are serialized per Browser identity and again at the Runtime command boundary, so Viewer-supporting captures cannot race Agent actions. Stop closes new admissions, drains already admitted bounded actions, and only then closes the corresponding tab; closing the last tab closes the Session but never the external browser process. Stale runtime and Viewer generations are rejected. Agent Chat/Terminal switches retain the Resource, stopping or archiving the Agent stops its runtime while retaining the row and profile, resuming starts it only on demand, and deleting the Agent removes its Resources and owned profiles. A Farming restart marks previously live rows failed. Every persisted mutation increments both the row revision and a collection revision. The backend registers live event listeners before emitting the authoritative collection snapshot, and the UI reduces HTTP, EventSource, and Viewer updates by those revisions so delayed transport delivery cannot regress or remove newer state.

All three sources use the same exact, version-locked `agent-browser` runtime. Installation and update preparation download the package-lock-pinned public npm tarball while the old Server remains available, verify its integrity, and extract only the current platform entry into Farming's immutable cache. Server startup verifies that cache before opening its port and repairs it only for a fresh install or a missing or invalid entry; a system `agent-browser` installation is never reused.

Chromium has a separate, explicit lifecycle and is never part of startup dependency preparation. Its authoritative states are `absent -> installing -> ready | failed`; `updateAvailable` is derived when a valid managed Chromium exists for an older `agent-browser` version but not the current one. Only the Install or Update action in **Plugins → Browser** may enter `installing`. Concurrent requests join one operation, a config-scoped lock prevents two Server processes from publishing the same cache, and downloads go to a private staging directory with isolated HOME and XDG paths. Farming probes its reviewed Google Chrome for Testing and npmmirror endpoints concurrently, orders reachable sources by bounded probe latency, and continues to the next source after a proven failure. The Google path invokes the pinned `agent-browser install` command without `--with-deps`; the mirror path downloads the same platform archive into the same private staging boundary. An unproven installer-process exit stops fallback and retains ownership evidence. The exact browser executable must be found and successfully report its version before an install manifest and version directory are atomically published under `<config-dir>/runtimes/chromium/<agent-browser-version>/<platform>/`. A failed, timed-out, interrupted, or unverified install never becomes selectable; it ends visibly in `failed` and may be retried. After an `agent-browser` upgrade, the same action installs the matching managed Chromium before it can be selected.

The user selects automatic/system Chromium, Farming-managed Chromium, or an external loopback CDP endpoint in **Plugins → Browser**; automatic selection prefers an available system Chromium before an already-installed managed Chromium. Source selection is ordinary persisted product configuration and does not require restarting Farming. For a local Resource, Farming gives the selected Chromium executable and isolated profile to the managed runtime; there is no separate Farming Chromium launcher or automation implementation. For an external Resource, the same runtime connects to the configured loopback endpoint and creates one labeled tab. Farming does not access Docker or manage containers.

The authenticated Viewer proxies the runtime's session-scoped WebSocket stream. Frames are JPEG to keep interaction responsive, while viewport, pointer, wheel, keyboard, and text input return through the same Session. The Viewer paints at the frame's reported CSS dimensions and discards superseded frames when a client is slow. Agent commands and human input therefore operate the same Browser identity without Farming carrying a second raw-CDP action path.

When the Browser plugin is enabled at an ACP Session boundary, Farming mounts its complete granular `browser_*` MCP catalog into Codex, Claude Code, OpenCode, and Qoder through the existing Provider Adapter. `browser_open` creates, mounts, and starts an Agent-owned Resource; the remaining tools keep explicit lifecycle, navigation, interaction, inspection, diagnostics, state, and file contracts. The CLI is the Terminal transport to the same contract, not a second implementation. Enabling Browser after an ACP Session has already started requires a visible Chat runtime restart before those schemas become available.

Every supported Agent also receives the same small Farming startup bootstrap at each Terminal process or ACP Session creation and recovery boundary, without modifying the Project or provider-owned instruction files. The bootstrap explains that Farming wraps `agent-browser` as a structured Agent control surface and a shared Viewer, so the Agent can operate the page effectively while the user can understand and take over the same session. It tells the Agent to query capabilities through the instance-exact `"$FARMING_CLI_BIN_DIR/farming"` entrypoint, rather than relying on a login shell's reordered `PATH`, and never to assume a capability exists. It directs the Agent to prefer the most direct, structured, low-overhead and verifiable available capability: repository CLI and files first, then native structured capabilities such as Web Search for public research or authorized service-specific connectors. A Browser Resource is for interaction, login/forms, visual or console/network inspection, user review or handoff—not ordinary search or static reading. When that browser path is needed and available, the Agent uses Farming Browser and leaves reviewable final state in a user-clickable Browser Resource. Computer is reserved for desktop-only UI, browser chrome, permission dialogs, or non-web apps that the CLI, a structured service tool, and Farming Browser cannot handle. Terminal Agents discover their own Resources with Browser `list`; top-level Browser help reveals only starting points, `help workflow` gives the normal flow, topic help reveals one capability domain, and command help finally reveals exact arguments. `farming-browser` remains the npm bin alias, and `farming browser mcp` remains the standard stdio entry used by the Provider Adapter and explicit external callers. The complete supported contract is documented in [Farming Browser for Agents](./browser-agent-cli.md).

Farming Code should be able to grow through Extensions instead of adding every new resource and Agent capability directly to the core product. A browser is the motivating example, but it should not become a one-off browser subsystem.

Farming Code exposes these capabilities through one Plugins view. A compact puzzle button in the top-left navigation and a large Plugins action on the empty welcome surface open that same view. Plugin lifecycle and configuration belong there rather than in general Settings. Opening the Plugins view is read-only; enabling or disabling a plugin remains an explicit action.

Farming ships one default optional HTTPS public mirror for the pinned runtime tarball. Farming uses it only when a bounded exact-version metadata lookup returns the same version and SRI; otherwise, or if that download later fails, Farming uses the authoritative npm URL from the manifest. `FARMING_RUNTIME_NPM_MIRROR` may override the packaged candidate or disable it with `off`.

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

When Farming starts or resumes an Agent, it injects the short Farming bootstrap through the Provider Adapter at every Terminal process and ACP Session boundary. Codex receives it as developer instructions, Claude Code as an appended system prompt, OpenCode as a process-local instructions file, and Qoder as an appended system prompt. Live availability remains outside the prompt: `farming capabilities` reports whether Browser is disabled, unavailable, or available. When Browser is enabled at a newly created ACP Session boundary, the same Provider Adapter also projects Farming's complete `browser_*` MCP catalog automatically. Terminal Agents use the progressive `farming browser` CLI on demand; `farming browser mcp` remains available as the stdio transport for explicit manual integrations. Tool identity, schema, ownership, permission policy and result semantics remain defined by Farming's Extension contract.

The intended relationship is:

```text
Extension runtime and viewer
          |
          | Farming Extension contract
          v
Farming resource UI + Agent capability registry
          |
          | startup bootstrap + ACP MCP or Terminal CLI
          v
Codex / Claude / OpenCode / Qoder
```

Agents may still have native or user-installed tools of their own. Farming does not silently replace those tools. Tool ownership and name collisions must be explicit, and the active Agent must be able to discover which capabilities are supplied by Farming and which are provider-native.

## Browser As An Extension

Farming's Browser Extension owns each Browser Resource identity and the page target shown by its Viewer and Agent tools. Resources owned by the same Agent and using the same Browser source share one agent-browser Session. Different Agents remain isolated. A local Session owns its Chromium process and isolated profile. An external-CDP Session owns only its connection and created targets, never the externally managed browser, profile, or endpoint lifecycle.

The MVP intentionally uses one operations implementation: the pinned `agent-browser` command and stream protocols, reached through a system-browser executable, the version-matched Farming-managed Chromium executable, or an external-CDP connection. Its structured Agent surface covers navigation and waits, DOM interaction, inspection and JavaScript, console/error/network diagnostics, cookies/storage, frames/dialogs, and Project-scoped upload/download. It does not expose the browser's native window chrome, extensions, download UI, DevTools windows, arbitrary desktop interaction or Computer Use. Those are separate product capabilities rather than hidden fallback paths.

Each Browser has a durable unique id, an Agent owner, and a Project root used for file isolation. In the sidebar it is hidden by default under **Agent → Resources → Browsers**; expanding or collapsing that hierarchy never changes runtime or Viewer state. It may be opened directly with the `browser` URL query parameter. Deleting a system-browser row stops its exact runtime before removing its isolated profile. Deleting an external-CDP row closes only Farming-created targets.

The Viewer address bar accepts a complete HTTP(S) URL or a bare host. Bare public domain names default to HTTPS; loopback addresses, IP literals, single-label intranet hosts, and explicit non-default ports default to HTTP. Farming does not guess a `www` hostname. A failed navigation remains visible, while the next navigation clears that error as soon as a new attempt starts and keeps it cleared after success. Viewer keyboard input uses a hidden text proxy so committed IME text and paste data reach the page; ordinary ASCII keystrokes stay on the low-latency stream path.

## Open Design Questions

The first implementation must resolve these before the Extension API is treated as stable:

- how an explicit future handoff promotes an Agent-owned Resource into a Project-shared Resource;
- how tool-name collisions and provider-native equivalents are surfaced;
- how Extension UI is isolated and authorized inside the Farming page;
- which lifecycle and recovery guarantees Farming core requires from a live Extension runtime.

The architectural constraint is already clear: resource presentation and Agent tools belong to one Extension, while Provider-specific translation stays at the existing Provider Adapter boundary.
