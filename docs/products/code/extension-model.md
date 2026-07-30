# Farming Code Extension Model

> Chinese version: [extension-model.zh_cn.md](./extension-model.zh_cn.md)

Status: the internal Viewer foundation and agent-browser-backed Browser Resource MVP are implemented; this is not yet a public third-party extension API.

## Implemented Foundation

Project Files now resolves built-in Markdown, SVG, and HTML viewers through one internal Viewer Registry. This establishes the first narrow Extension boundary without introducing package installation, dynamic third-party code, or a second editor framework.

The static HTML viewer uses the existing file tab and Source / Preview interaction. A bounded in-memory Preview Session authorizes resources under the selected project root and serves them through Farming's existing authenticated HTTP service, so it opens no additional listening port. The browser renders the current unsaved draft in a sandboxed iframe, disables scripts, form submission, nested frames, and active network APIs, and resolves only authorized relative static assets through that Preview Session. Relative HTML navigation stays inside the same Session, including workspace-root-relative assets on the destination page. Closing the viewer deletes its session; expiration and capacity limits bound abandoned sessions.

An explicitly opened readable file outside known project roots remains read-only. For exact external HTML preview, the temporary Preview Session authorizes only the HTML file's containing directory so its relative assets can load; it does not add that directory to Files browsing, search, editing, or Git scope.

The Browser Extension is the first live Resource implementation. Its integration is disabled by default. The Plugins view offers Automatic, a discovered local Chromium, and Isolated Browser. Automatic prefers a compatible local executable and otherwise uses an already-prepared isolated runtime. Ordinary users never configure a CDP address. Only an enabled and currently available Extension contributes Browser UI or accepts Browser API, EventSource, Viewer WebSocket, CLI, or MCP operations.

Each live Agent may own multiple stable, renameable Browser rows with an explicit `stopped -> starting -> running -> stopping -> stopped` lifecycle; startup or runtime failure ends in `failed`. The Project root remains the filesystem and upload/download boundary, but it is not the runtime owner. Running rows owned by the same Agent and using the same Browser source are labeled tabs in one shared agent-browser Session. Different Agents never share that Session, profile, cookies, or storage even when they belong to the same Project. A local Session owns its Chromium process and isolated profile. An isolated Session owns a lease on one exact labeled Docker container for that Browser owner; its internal loopback CDP address is transport, not user configuration. Operations are serialized per Browser identity and again at the Runtime command boundary, so Viewer-supporting captures cannot race Agent actions. Stop closes new admissions, drains already admitted bounded actions, closes the tabs and Session, and then stops the isolated container when its last lease ends. Stale runtime and Viewer generations are rejected. Agent Chat/Terminal switches retain the Resource, stopping or archiving the Agent stops its runtime while retaining the row and profile, resuming starts it only on demand, and deleting the Agent removes its Resources, profiles, and isolated Browser container. A Farming restart marks previously live rows failed and stops proven orphan containers before recovery. Every persisted mutation increments both the row revision and a collection revision. The backend registers live event listeners before emitting the authoritative collection snapshot, and the UI reduces HTTP, EventSource, and Viewer updates by those revisions so delayed transport delivery cannot regress or remove newer state.

All three sources use the same exact, version-locked `agent-browser` runtime. Installation and update preparation download the package-lock-pinned public npm tarball while the old Server remains available, verify its integrity, and extract only the selected platform entry into Farming's immutable cache. On legacy Linux, only this dependency selects the statically linked musl entry from the same package; Codex and Claude keep their normal platform entries. The active manifest records the selection per dependency so cache pruning retains the live artifact. Server startup verifies that cache before opening its port and repairs it only for a fresh install or a missing or invalid entry; a system `agent-browser` installation is never reused.

Chromium has a separate, explicit lifecycle and is never part of startup dependency preparation. Preparing Isolated Browser is the only primary download path in the Plugins UI. It explicitly pulls the pinned upstream `trycua/cuabot` 1.0.5 image (about 2 GB compressed). Farming probes the reviewed registry names concurrently with bounded timeouts, tries them in measured-latency order, and requires every name to resolve to the same exact digest. A standard Docker daemon mirror, including an account-scoped Alibaba Cloud accelerator, may satisfy those pulls without becoming Farming configuration. Farming runs a real Chromium/CDP probe before publishing the image as ready. Concurrent prepare requests join one operation. No image is pulled during install, update, or Server startup.

Source selection is ordinary persisted product configuration and does not require restarting Farming. For a local Resource, Farming gives the selected Chromium executable and isolated profile to the managed `agent-browser` runtime. For an isolated Resource, the Computer extension owns Docker creation and exact labels, relays Chromium's container-loopback CDP to host loopback, and gives the endpoint privately to that same runtime. This is a separate Agent-owned Browser container rather than the full Computer desktop container, because the reviewed desktop image does not contain Chromium. The Browser extension still has only one automation and Viewer implementation. Legacy managed-Chromium and external-CDP settings remain read compatibility paths, not ordinary Plugins choices.

The authenticated Viewer proxies the runtime's session-scoped WebSocket stream. Frames are JPEG to keep interaction responsive, while viewport, pointer, wheel, keyboard, and text input return through the same Session. The Viewer paints at the frame's reported CSS dimensions and discards superseded frames when a client is slow. Agent commands and human input therefore operate the same Browser identity without Farming carrying a second raw-CDP action path.

When the Browser plugin is enabled at an ACP Session boundary, Farming mounts its complete granular `browser_*` MCP catalog into Codex, Claude Code, OpenCode, and Qoder through the existing Provider Adapter. `browser_open` creates, mounts, and starts an Agent-owned Resource; the remaining tools keep explicit lifecycle, navigation, interaction, inspection, diagnostics, state, and file contracts. The CLI is the Terminal transport to the same contract, not a second implementation. Enabling Browser after an ACP Session has already started requires a visible Chat runtime restart before those schemas become available.

Every supported Agent also receives the same small Farming startup bootstrap at each Terminal process or ACP Session creation and recovery boundary, without modifying the Project or provider-owned instruction files. The bootstrap explains that Farming wraps `agent-browser` as a structured Agent control surface and a shared Viewer, so the Agent can operate the page effectively while the user can understand and take over the same session. It tells the Agent to query capabilities through the instance-exact `"$FARMING_CLI_BIN_DIR/farming"` entrypoint, rather than relying on a login shell's reordered `PATH`, and never to assume a capability exists. It directs the Agent to first select the information source: repository CLI and files for project code, build, and local state; native structured capabilities such as Web Search or authorized service-specific connectors for public research, competitors, industry facts, and external product behavior. A repository keyword is not by itself a reason to search local files. For public or competitor research it first defines comparison dimensions and representative products, normally selects three representatives with distinct semantics, and has a hard efficiency limit of six total search, page-open, and find operations: after the sixth external read it must answer from the evidence already gathered. It may exceed that limit only on the user's explicit request or where directly conflicting evidence can change the conclusion category. It batches independent searches where supported, verifies each key conclusion with only the necessary first-party pages, and stops once it can explain support, user operation, and effect on existing versus new data; absent or conflicting evidence remains explicit rather than inviting low-value serial search. A Browser Resource is for interaction, login/forms, visual or console/network inspection, user review or handoff—not ordinary search or static reading. When that browser path is needed and available, the Agent uses Farming Browser and leaves reviewable final state in a user-clickable Browser Resource. Computer is reserved for desktop-only UI, browser chrome, permission dialogs, or non-web apps that the CLI, a structured service tool, and Farming Browser cannot handle. Terminal Agents discover their own Resources with Browser `list`; top-level Browser help reveals only starting points, `help workflow` gives the normal flow, topic help reveals one capability domain, and command help finally reveals exact arguments. `farming-browser` remains the npm bin alias, and `farming browser mcp` remains the standard stdio entry used by the Provider Adapter and explicit external callers. The complete supported contract is documented in [Farming Browser for Agents](./browser-agent-cli.md).

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

Farming's Browser Extension owns each Browser Resource identity and the page target shown by its Viewer and Agent tools. Resources owned by the same Agent and using the same Browser source share one agent-browser Session. Different Agents remain isolated. A local Session owns its Chromium process and isolated profile. An isolated Session owns one lease on the exact labeled Browser container managed by the Computer extension. Legacy external-CDP Sessions own only their connection and created targets, never the externally managed browser, profile, or endpoint lifecycle.

The MVP intentionally uses one operations implementation: the pinned `agent-browser` command and stream protocols, reached through a system-browser executable or the private loopback CDP endpoint of an isolated Browser container. Legacy managed-Chromium and external-CDP settings remain read compatibility paths only. Its structured Agent surface covers navigation and waits, DOM interaction, inspection and JavaScript, console/error/network diagnostics, cookies/storage, frames/dialogs, and Project-scoped upload/download. It does not expose the browser's native window chrome, extensions, download UI, DevTools windows, arbitrary desktop interaction or Computer Use. Those are separate product capabilities rather than hidden fallback paths.

Each Browser has a durable unique id, an Agent owner, and a Project root used for file isolation. In the sidebar it is hidden by default under **Agent → Resources → Browsers**; expanding or collapsing that hierarchy never changes runtime or Viewer state. It may be opened directly with the `browser` URL query parameter. Deleting a system-browser row stops its exact runtime before removing its isolated profile. Deleting the last isolated row for an owner stops and removes the exact verified container. A legacy external-CDP row closes only Farming-created targets.

The Viewer address bar accepts a complete HTTP(S) URL or a bare host. Bare public domain names default to HTTPS; loopback addresses, IP literals, single-label intranet hosts, and explicit non-default ports default to HTTP. Farming does not guess a `www` hostname. A failed navigation remains visible, while the next navigation clears that error as soon as a new attempt starts and keeps it cleared after success. Viewer keyboard input uses a hidden text proxy so committed IME text and paste data reach the page; ordinary ASCII keystrokes stay on the low-latency stream path.

## Open Design Questions

The first implementation must resolve these before the Extension API is treated as stable:

- how an explicit future handoff promotes an Agent-owned Resource into a Project-shared Resource;
- how tool-name collisions and provider-native equivalents are surfaced;
- how Extension UI is isolated and authorized inside the Farming page;
- which lifecycle and recovery guarantees Farming core requires from a live Extension runtime.

The architectural constraint is already clear: resource presentation and Agent tools belong to one Extension, while Provider-specific translation stays at the existing Provider Adapter boundary.
