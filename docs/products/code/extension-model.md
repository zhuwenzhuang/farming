# Farming Code Extension Model

> Chinese version: [extension-model.zh_cn.md](./extension-model.zh_cn.md)

Status: the internal Viewer foundation and agent-browser-backed Browser Resource MVP are implemented; this is not yet a public third-party extension API.

## Implemented Foundation

Project Files now resolves built-in Markdown, SVG, and HTML viewers through one internal Viewer Registry. This establishes the first narrow Extension boundary without introducing package installation, dynamic third-party code, or a second editor framework.

The static HTML viewer uses the existing file tab and Source / Preview interaction. A bounded in-memory Preview Session authorizes resources under the selected project root and serves them through Farming's existing authenticated HTTP service, so it opens no additional listening port. The browser renders the current unsaved draft in a sandboxed iframe, disables scripts, form submission, nested frames, and active network APIs, and resolves only authorized relative static assets through that Preview Session. Relative HTML navigation stays inside the same Session, including workspace-root-relative assets on the destination page. Closing the viewer deletes its session; expiration and capacity limits bound abandoned sessions.

An explicitly opened readable file outside known project roots remains read-only. For exact external HTML preview, the temporary Preview Session authorizes only the HTML file's containing directory so its relative assets can load; it does not add that directory to Files browsing, search, editing, or Git scope.

The Browser Extension is the first live Resource implementation. Its integration is disabled by default. The Plugins view offers Automatic, a discovered local Chromium, and Isolated Browser. Automatic prefers a compatible local executable and otherwise uses an already-prepared isolated runtime. Ordinary users never configure a CDP address. Only an enabled and currently available Extension contributes Browser UI or accepts Browser API, EventSource, Viewer WebSocket, CLI, or MCP operations.

Each live Agent may own multiple stable, renameable Browser rows with an explicit `stopped -> starting -> running -> stopping -> stopped` lifecycle; startup or runtime failure ends in `failed`. The Project root remains the filesystem and upload/download boundary, but it is not the runtime owner. Running rows owned by the same Agent and using the same Browser source are labeled tabs in one shared agent-browser Session. Different Agents never share that Session, profile, cookies, or storage even when they belong to the same Project. A local Session owns its Chromium process and isolated profile. An isolated Session leases the Agent's one visible Computer; its internal loopback CDP address is transport, not user configuration. Operations are serialized per Browser identity and again at the Runtime command boundary, so Viewer-supporting captures cannot race Agent actions. Stop closes new admissions, drains already admitted bounded actions, and closes the tabs and Session, but the Agent lifecycle—not an individual Browser row—owns the Computer container. Stale runtime and Viewer generations are rejected. Agent Chat/Terminal switches retain both Resources, stopping or archiving the Agent stops their runtimes while retaining the rows and profile, resuming starts them only on demand, and deleting the Agent removes its Browser Resources, profiles, and exact Computer. A Farming restart marks previously live Browser rows failed and removes only exact legacy hidden Browser containers before recovery. Every persisted mutation increments both the row revision and a collection revision. The backend registers live event listeners before emitting the authoritative collection snapshot, and the UI reduces HTTP, EventSource, and Viewer updates by those revisions so delayed transport delivery cannot regress or remove newer state.

All three sources use the same exact, version-locked `agent-browser` runtime. Installation and update preparation download the package-lock-pinned public npm tarball while the old Server remains available, verify its integrity, and extract only the selected platform entry into Farming's immutable cache. On legacy Linux, only this dependency selects the statically linked musl entry from the same package; Codex and Claude keep their normal platform entries. The active manifest records the selection per dependency so cache pruning retains the live artifact. Server startup verifies that cache before opening its port and repairs it only for a fresh install or a missing or invalid entry; a system `agent-browser` installation is never reused.

Chromium has a separate, explicit lifecycle and is never part of startup dependency preparation. Preparing Isolated Browser is the only primary download path in the Plugins UI. It prepares the exact pinned upstream Computer image, downloads Linux Chromium into Farming's managed cache through bounded latency-ranked sources, and verifies that executable inside the Computer image before publishing it as ready. A standard Docker daemon mirror, including an account-scoped Alibaba Cloud accelerator, may satisfy the Computer pull without becoming Farming configuration. Concurrent prepare requests join one operation. No image or Chromium archive is pulled during install, update, or Server startup.

Source selection is ordinary persisted product configuration and does not require restarting Farming. For a local Resource, Farming gives the selected Chromium executable and isolated profile to the managed `agent-browser` runtime. For an isolated Resource, the Computer extension owns Docker creation and exact labels, mounts managed Chromium read-only into that visible desktop, relays Chromium's container-loopback CDP to host loopback, and gives the endpoint privately to the same runtime. Enabling Isolated Browser therefore also keeps Computer enabled. The Browser extension still has only one automation and Viewer implementation. Legacy managed-Chromium and external-CDP settings remain read compatibility paths, not ordinary Plugins choices.

The authenticated Viewer proxies the runtime's session-scoped WebSocket stream. Frames are JPEG to keep interaction responsive, while viewport, pointer, wheel, keyboard, and text input return through the same Session. The Viewer paints at the frame's reported CSS dimensions and discards superseded frames when a client is slow. Agent commands and human input therefore operate the same Browser identity without Farming carrying a second raw-CDP action path.

When the Browser plugin is enabled at an ACP Session boundary, Farming mounts its complete granular `browser_*` MCP catalog into Codex, Claude Code, OpenCode, and Qoder through the existing Provider Adapter. `browser_open` creates, mounts, and starts an Agent-owned Resource; the remaining tools keep explicit lifecycle, navigation, interaction, inspection, diagnostics, state, and file contracts. The CLI is the Terminal transport to the same contract, not a second implementation. Enabling Browser after an ACP Session has already started requires a visible Chat runtime restart before those schemas become available.

Every supported Agent also receives the same small Farming startup bootstrap at each Terminal process or ACP Session creation and recovery boundary, without modifying the Project or provider-owned instruction files. The bootstrap explains that Farming wraps `agent-browser` as a structured Agent control surface and a shared Viewer, so the Agent can operate the page effectively while the user can understand and take over the same session. It tells the Agent to query capabilities through the instance-exact `"$FARMING_CLI_BIN_DIR/farming"` entrypoint, rather than relying on a login shell's reordered `PATH`, and never to assume a capability exists. Tool selection is based on overall efficiency, reliability, verifiability, and task fit. Provider-native capabilities, available CLIs, project tools, and service-specific connectors take precedence for work that does not inherently require an interactive surface whenever they can complete it more directly, quickly, or reliably. When the task itself requires browser or full-desktop interaction and the corresponding Farming capability is available, the Agent prefers Farming Browser or Computer so the user and Agent can observe, operate, and hand off the same shared Resource. Explicit user tool choices still win. Terminal Agents discover their own Resources with Browser `list`; top-level Browser help reveals only starting points, `help workflow` gives the normal flow, topic help reveals one capability domain, and command help finally reveals exact arguments. `farming-browser` remains the npm bin alias, and `farming browser mcp` remains the standard stdio entry used by the Provider Adapter and explicit external callers. The complete supported contract is documented in [Farming Browser for Agents](./browser-agent-cli.md).

Farming Code should be able to grow through Extensions instead of adding every new resource and Agent capability directly to the core product. A browser is the motivating example, but it should not become a one-off browser subsystem.

Farming Code exposes these capabilities through one Plugins view. A compact puzzle button in the top-left navigation and a large Plugins action on the empty welcome surface open that same view. Plugin lifecycle, Agent Home management, and fresh-Agent defaults belong there rather than in general Settings. Every mutation remains an explicit user action.

The same view owns Agent configuration. One provider plus one Agent Home id is one independent Agent configuration: `Codex · default` and `Codex · work` are separate entries, even though both use Codex. Skills, plugins, and commands are discovered and rendered under the exact Home that owns them; Farming never merges extensions from multiple Homes into a provider-wide list. The ordered `agentHomes` registry in global Farming settings is authoritative. A new entry appends, drag or keyboard movement rewrites its stable numeric order, and only a non-default entry may be removed. Agent Home management therefore no longer appears in general Settings.

Each Agent configuration also owns the defaults used only when Farming creates a fresh Agent: model, reasoning effort, and Fast where the provider supports it. `inherit` is the default and means Farming supplies no corresponding provider override. Codex maps explicit Fast on/off to priority/default service tier; Claude supports model and effort but not Fast; providers without a supported pre-start configuration contract remain provider-managed. Terminal and ACP Chat resolve the same Home defaults at their shared Agent-start boundary. Resuming an existing provider Session preserves that Session's profile instead of replacing it with fresh-Agent defaults.

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

Farming's Browser Extension owns each Browser Resource identity and the page target shown by its Viewer and Agent tools. Resources owned by the same Agent and using the same Browser source share one agent-browser Session. Different Agents remain isolated. A local Session owns its Chromium process and isolated profile. An isolated Session owns one lease on the Agent's exact visible Computer managed by the Computer extension. Legacy external-CDP Sessions own only their connection and created targets, never the externally managed browser, profile, or endpoint lifecycle.

The MVP intentionally uses one operations implementation: the pinned `agent-browser` command and stream protocols, reached through a system-browser executable or the private loopback CDP endpoint of the Agent's Computer. Legacy managed-Chromium and external-CDP settings remain read compatibility paths only. Its structured Agent surface covers navigation and waits, DOM interaction, inspection and JavaScript, console/error/network diagnostics, cookies/storage, frames/dialogs, and Project-scoped upload/download. Computer remains the separate full-desktop control surface for native browser chrome, dialogs, and arbitrary Linux applications; both viewers observe the same isolated Chromium when that source is selected.

Each Browser has a durable unique id, an Agent owner, and a Project root used for file isolation. In the sidebar it is hidden by default under **Agent → Resources → Browsers**; expanding or collapsing that hierarchy never changes runtime or Viewer state. The isolated Computer is a separate visible Agent Resource and remains present after Browser Stop or Delete. A Browser may be opened directly with the `browser` URL query parameter. Deleting a system-browser row stops its exact runtime before removing its isolated profile. Deleting an isolated row closes only its tab/Session; deleting the Agent owns exact Computer removal. A legacy external-CDP row closes only Farming-created targets.

The Viewer address bar accepts a complete HTTP(S) URL or a bare host. Bare public domain names default to HTTPS; loopback addresses, IP literals, single-label intranet hosts, and explicit non-default ports default to HTTP. Farming does not guess a `www` hostname. A failed navigation remains visible, while the next navigation clears that error as soon as a new attempt starts and keeps it cleared after success. Viewer keyboard input uses a hidden text proxy so committed IME text and paste data reach the page; ordinary ASCII keystrokes stay on the low-latency stream path.

## Open Design Questions

The first implementation must resolve these before the Extension API is treated as stable:

- how an explicit future handoff promotes an Agent-owned Resource into a Project-shared Resource;
- how tool-name collisions and provider-native equivalents are surfaced;
- how Extension UI is isolated and authorized inside the Farming page;
- which lifecycle and recovery guarantees Farming core requires from a live Extension runtime.

The architectural constraint is already clear: resource presentation and Agent tools belong to one Extension, while Provider-specific translation stays at the existing Provider Adapter boundary.
