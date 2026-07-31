# Farming Code Extension Model

> Chinese version: [extension-model.zh_cn.md](./extension-model.zh_cn.md)

Status: the internal Viewer foundation and agent-browser-backed Browser Resource MVP are implemented; this is not yet a public third-party extension API.

## Implemented Foundation

Project Files now resolves built-in Markdown, SVG, and HTML viewers through one internal Viewer Registry. This establishes the first narrow Extension boundary without introducing package installation, dynamic third-party code, or a second editor framework.

The static HTML viewer uses the existing file tab and Source / Preview interaction. A bounded in-memory Preview Session authorizes resources under the selected project root and serves them through Farming's existing authenticated HTTP service, so it opens no additional listening port. The browser renders the current unsaved draft in a sandboxed iframe, disables scripts, form submission, nested frames, and active network APIs, and resolves only authorized relative static assets through that Preview Session. Relative HTML navigation stays inside the same Session, including workspace-root-relative assets on the destination page. Closing the viewer deletes its session; expiration and capacity limits bound abandoned sessions.

An explicitly opened readable file outside known project roots remains read-only. For exact external HTML preview, the temporary Preview Session authorizes only the HTML file's containing directory so its relative assets can load; it does not add that directory to Files browsing, search, editing, or Git scope.

The Browser Extension is the first live Resource implementation. Its integration is disabled by default. The Plugins view shows each discovered local Chromium browser by name and keeps Isolated Browser visible as a separate explicit source. The first compatible local browser is persisted as the initial selection; if that executable later disappears, Browser becomes unavailable instead of silently switching sources. Isolated Browser states whether Docker is required or whether its runtime still needs preparation. Ordinary users never configure a CDP address. Only an enabled and currently available Extension contributes Browser UI or accepts Browser API, Viewer WebSocket, CLI, or MCP operations.

Each live Agent may own multiple stable, renameable Browser rows with an explicit `stopped -> starting -> running -> stopping -> stopped` lifecycle; startup or runtime failure ends in `failed`. The Project root remains the filesystem and upload/download boundary, but it is not the runtime owner. Running rows owned by the same Agent and using the same Browser source are labeled tabs in one shared agent-browser Session. Different Agents never share that Session, profile, cookies, or storage even when they belong to the same Project. A local Session owns its Chromium process and isolated profile. An isolated Session leases the Agent's one visible Computer; its internal loopback CDP address is transport, not user configuration. Operations are serialized per Browser identity and again at the Runtime command boundary, so Viewer-supporting captures cannot race Agent actions. Stop closes new admissions, drains already admitted bounded actions, and closes the tabs and Session, but the Agent lifecycle—not an individual Browser row—owns the Computer container. Stale runtime and Viewer generations are rejected. Agent Chat/Terminal switches retain both Resources, stopping or archiving the Agent stops their runtimes while retaining the rows and profile, resuming starts them only on demand, and deleting the Agent removes its Browser Resources, profiles, and exact Computer. On restart, every row that still retains an exact process identity re-enters cleanup even if an earlier attempt marked it failed; cleanup resolves the pinned `agent-browser` independently of whether the selected Browser source is currently usable. Every persisted mutation increments both the row revision and a collection revision. Each Farming page receives authoritative Browser and Computer collection snapshots after the versioned main WebSocket handshake, then receives revisioned, per-Resource coalesced metadata updates on that same control connection. Reconnect always repeats both snapshots. HTTP remains for current capability probes and lifecycle commands; Browser JPEG and Desktop noVNC streams remain separate on-demand WebSockets so image backpressure cannot block Chat, Terminal, or resource metadata. Opening a Terminal is foreground admission: the page aborts its in-flight low-priority usage and Agent-session prefetches before requesting the authoritative terminal checkpoint, so multi-page background navigation cannot consume every HTTP/1.1 connection slot. The UI reduces HTTP responses, main-WebSocket snapshots, deltas, and Viewer updates by revision so delayed transport delivery cannot regress or remove newer state.

All three sources use the same exact, version-locked `agent-browser` runtime. Installation and update preparation download the package-lock-pinned public npm tarball while the old Server remains available, verify its integrity, and extract only the selected platform entry into Farming's immutable cache. On legacy Linux, only this dependency selects the statically linked musl entry from the same package; Codex and Claude keep their normal platform entries. The active manifest records the selection per dependency so cache pruning retains the live artifact. Server startup verifies that cache before opening its port and repairs it only for a fresh install or a missing or invalid entry; a system `agent-browser` installation is never reused. When preparation must download an artifact, interactive CLI startup shows a compact in-place progress bar with transferred and total bytes, while redirected logs and remote deployment output receive bounded milestone lines instead of high-frequency updates. Cache hits stay quiet. HTTP `Content-Length` may improve the display when the manifest has no size, but only the pinned integrity remains authoritative for acceptance.

Chromium has a separate, explicit lifecycle and is never part of startup dependency preparation. Preparing Isolated Browser is the only primary download path in the Plugins UI. It prepares the exact pinned upstream Computer image, downloads Linux Chromium into Farming's managed cache through bounded latency-ranked sources, makes the cache path traversable through the read-only container mount, and verifies that executable as the actual in-container `cua` user before publishing it as ready. A standard Docker daemon mirror, including an account-scoped Alibaba Cloud accelerator, may satisfy the Computer pull without becoming Farming configuration. Concurrent prepare requests join one operation. No image or Chromium archive is pulled during install, update, or Server startup.

Source selection is ordinary persisted product configuration and does not require restarting Farming. For a local Resource, Farming gives the selected Chromium executable and isolated profile to the managed `agent-browser` runtime. For an isolated Resource, the Computer extension owns Docker creation and exact labels, mounts managed Chromium read-only into that visible desktop, relays Chromium's container-loopback CDP to host loopback, and gives the endpoint privately to the same runtime. A CDP readiness probe must close and release its relay connection before Browser runtime admission, so the following agent-browser connection cannot be blocked behind the probe. Enabling Isolated Browser therefore also keeps Computer enabled. The Browser extension still has only one automation and Viewer implementation. User-supplied external-CDP settings remain read compatibility paths, not ordinary Plugins choices.

The authenticated Viewer proxies the runtime's session-scoped WebSocket stream. Frames are JPEG to keep interaction responsive, while viewport, pointer, wheel, keyboard, and text input return through the same Session. The Viewer paints at the frame's reported CSS dimensions and discards superseded frames when a client is slow. Agent commands and human input therefore operate the same Browser identity without Farming carrying a second raw-CDP action path.

When the Browser plugin is enabled at an ACP Session boundary, Farming mounts its complete granular `browser_*` MCP catalog into Codex, Claude Code, OpenCode, and Qoder through the existing Provider Adapter. `browser_open` creates, mounts, and starts an Agent-owned Resource; the remaining tools keep explicit lifecycle, navigation, interaction, inspection, diagnostics, state, and file contracts. The CLI is the Terminal transport to the same contract, not a second implementation. Enabling Browser after an ACP Session has already started requires a visible Chat runtime restart before those schemas become available.

Every supported Agent also receives the same small Farming startup bootstrap at each Terminal process or ACP Session creation and recovery boundary, without modifying the Project or provider-owned instruction files. The bootstrap explains that Farming wraps `agent-browser` as a structured Agent control surface and a shared Viewer, so the Agent can operate the page effectively while the user can understand and take over the same session. It tells the Agent to query capabilities through the instance-exact `"$FARMING_CLI_BIN_DIR/farming"` entrypoint, rather than relying on a login shell's reordered `PATH`, and never to assume a capability exists. Tool selection is based on overall efficiency, reliability, verifiability, and task fit. Provider-native capabilities, available CLIs, project tools, and service-specific connectors take precedence for work that does not inherently require an interactive surface whenever they can complete it more directly, quickly, or reliably. When the task itself requires browser or full-desktop interaction and the corresponding Farming capability is available, the Agent prefers Farming Browser or Computer so the user and Agent can observe, operate, and hand off the same shared Resource. Explicit user tool choices still win. Terminal Agents discover their own Resources with Browser `list`; top-level Browser help reveals only starting points, `help workflow` gives the normal flow, topic help reveals one capability domain, and command help finally reveals exact arguments. `farming-browser` remains the npm bin alias, and `farming browser mcp` remains the standard stdio entry used by the Provider Adapter and explicit external callers. The complete supported contract is documented in [Farming Browser for Agents](./browser-agent-cli.md).

Farming Code should be able to grow through Extensions instead of adding every new resource and Agent capability directly to the core product. A browser is the motivating example, but it should not become a one-off browser subsystem.

Farming Code exposes these capabilities through one Plugins view with three presentation-only tabs: **Farming** for built-in capabilities, **Agent Homes** for provider Home registration and configuration summaries, and **Extensions** for the skills, MCPs, hooks, plugins, commands, and other extension kinds discovered from those Homes. Extensions first selects one exact Home and then offers kind tabs inside that Home, so catalogs from different Homes never become one undifferentiated list. A compact puzzle button in the top-left navigation and a large Plugins action on the empty welcome surface open that same view. The selected tabs are browser-local display state and never become authoritative backend settings. Plugin lifecycle and Agent Home management belong there rather than in general Settings. Every mutation remains an explicit user action.

Opening Plugins is a current-state boundary. Farming clears the previous Browser and Computer Use capability presentation and shows Checking until the new request succeeds. Agent Home and extension reads follow the same rule: failure stays visible and never falls back to data from an earlier visit.

Computer Use follows an explicit capability/resource hierarchy: **Computer Use**
is the plugin capability, while **Desktops** are the Resources it operates. The
target model admits Local Desktop and Isolated Desktop, but the UI exposes only
targets backed by a continuously verified runtime. The current implementation
therefore presents the Docker-backed Isolated Desktop; it does not show a
non-functional Local Desktop option. Internal `computer` APIs and `computer_*`
Agent tools remain compatibility names rather than user-visible resource names.

Resource-specific meaning does not create resource-specific sidebar chrome. Every
Browser, Desktop, and future Extension row under the Code sidebar composes the
core-owned `code-sidebar-resource-*` presentation contract for section headers,
row geometry, hover / active / focus states, action reveal surfaces, action-button
sizing, and empty rows. Extensions supply their icon, labels, status meaning, and
actions, while Extension-local CSS remains limited to genuinely resource-specific
presentation such as a Viewer or a semantic menu.

The same view owns Agent configuration. One provider plus one Agent Home id is one independent Agent configuration: `Codex · default` and `Codex · work` are separate entries, even though both use Codex. Each Agent Homes entry stays compact for scanning: Farming reads the provider-owned configuration file and renders only safe recognized fields as plain text, without nesting the Home's extension catalog inside the configuration row. Edit mounts that exact Home as a normal Project, opens its configuration file in Farming's existing file editor, and reveals the file in the Project tree, so editing, saving, and navigation use the normal Project Files path. If the file does not exist yet, the editor starts an empty working copy and creates it only on save. Every provider-facing catalog, settings, session, and extension read resolves the exact configured Home first, and every cache key includes that Home identity; a default Home result must never populate another Home. The Extensions tab keeps the selected Home explicit, scopes its kind counts and search to that Home, and shows only the selected kind's entries; Farming never collapses multiple Homes into one provider-wide identity. The ordered `agentHomes` registry in global Farming settings is authoritative. A new entry appends, drag or keyboard movement rewrites its stable numeric order, and only a non-default entry may be removed. Agent Home management therefore no longer appears in general Settings.

The first Extension Catalog release is deliberately read-only. Its parser follows the VS Code Agent Plugin parser's format-adapter shape and recognizes Agent Plugins v1 at root `plugin.json`, with its fixed `skills/` and `mcp.json` components, plus the provider-owned `.codex-plugin`, `.claude-plugin`, `.qoder-plugin`, `.plugin`, `.mcp.json`, Skill, Command, and Hook layouts already present below the exact Home. Agent Plugins package paths are resolved against the real filesystem and rejected if a symlink escapes the Plugin root. Farming reports **Enabled** or **Disabled** only when the provider's native configuration states that value explicitly; otherwise it says **Configured**. It does not keep a parallel enablement database, infer runtime activity, or expose a switch that the provider may ignore. Every item retains its Home-relative source file, and Open source file uses the existing Agent Home editor path.

### Agent Home Metadata And Identity

Agent Home metadata has three explicit ownership layers:

```text
Global settings: agentHomes[provider][]
  owns enabled Home id, path, and order
                    |
                    | selected when Farming creates an Agent
                    v
Private Farming agent_* record
  owns immutable providerHomeId + providerHomePath binding snapshot
                    |
                    | combined with the provider's stable Session id
                    v
Provider Session identity
  provider + providerHomeId + providerSessionId
```

The settings registry controls only which configurations accept fresh Agents. Removing a non-default entry does not rewrite or delete existing Agent records. History, recovery, runtime replacement, catalogs used by a live Agent, and provider operations continue resolving the exact path retained by those private records. Re-adding the same Home id is legal only with that same canonical path while any private binding survives. Changing a Home path is legal only before the Home owns a persisted Agent binding; otherwise the user creates another Home. Within one provider, canonical Home paths are unique, so one provider store cannot be scanned and presented as two different Agent identities.

The Settings snapshot owns Home mutation admission. Add and reorder commit atomically with the snapshot; an invalid duplicate id/path or a referenced-id path change fails without changing settings. Remove unregisters the configuration for fresh Agents while retained private bindings keep existing Sessions live. On restart, a configured Home that conflicts with a retained binding fails visibly instead of silently relabeling Sessions.

OpenCode requires one extra join because its provider Session listing is global rather than partitioned by configuration directory. Farming records the Home selected when it creates or first adopts that Session, refuses to bind the same OpenCode Session to a second Home, and joins the private binding back into History. An externally created OpenCode Session with no Farming binding remains associated with the configured default Home until the user first adopts it.

The provider configuration file inside the selected Home is authoritative for fresh-Agent model, reasoning, service tier, and other provider settings. Farming supplies no Home-level model/reasoning/Fast override in either Terminal or ACP Chat startup. Legacy persisted `newAgentDefaults` fields remain a read-compatibility shape but do not affect launch behavior and are rewritten to `inherit` when the Plugins client next saves the Home registry. Resuming an existing provider Session continues to preserve that Session's provider-owned profile.

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

The MVP intentionally uses one operations implementation: the pinned `agent-browser` command and stream protocols, reached through a system-browser executable or the private loopback CDP endpoint of the Agent's Computer. User-supplied external-CDP settings remain read compatibility paths only. Its structured Agent surface covers navigation and waits, DOM interaction, inspection and JavaScript, console/error/network diagnostics, cookies/storage, frames/dialogs, and Project-scoped upload/download. Computer Use remains the separate full-desktop capability for native browser chrome, dialogs, and arbitrary Linux applications; its Desktop Viewer and the Browser Viewer observe the same isolated Chromium when that source is selected.

Each Browser has a durable unique id, an Agent owner, and a Project root used for file isolation. When Browser or Computer Use is enabled and available, the Agent row exposes its Resources control even before the first Resource exists; the Agent menu also offers **Create Browser** and, while no Desktop exists, **Create Isolated Desktop**. In the sidebar these Resources are hidden by default under **Agent → Resources → Browsers / Desktops**; expanding or collapsing that hierarchy never changes runtime or Viewer state. A stopped, failed, starting, or stopping Browser row has no status dot; only a running row shows one green dot aligned at the far right. The Isolated Desktop remains present after Browser Stop or Delete. A Browser may be opened directly with the `browser` URL query parameter. Deleting a system-browser row stops its exact runtime before removing its isolated profile. Deleting an isolated row closes only its tab/Session; deleting the Agent owns exact Desktop removal. A legacy external-CDP row closes only Farming-created targets.

The Viewer address bar accepts a complete HTTP(S) URL or a bare host. Bare public domain names default to HTTPS; loopback addresses, IP literals, single-label intranet hosts, and explicit non-default ports default to HTTP. Farming does not guess a `www` hostname. A failed navigation remains visible, while the next navigation clears that error as soon as a new attempt starts and keeps it cleared after success. Viewer keyboard input uses a hidden text proxy so committed IME text and paste data reach the page; ordinary ASCII keystrokes stay on the low-latency stream path.

## Open Design Questions

The first implementation must resolve these before the Extension API is treated as stable:

- how an explicit future handoff promotes an Agent-owned Resource into a Project-shared Resource;
- how tool-name collisions and provider-native equivalents are surfaced;
- how Extension UI is isolated and authorized inside the Farming page;
- which lifecycle and recovery guarantees Farming core requires from a live Extension runtime.

The architectural constraint is already clear: resource presentation and Agent tools belong to one Extension, while Provider-specific translation stays at the existing Provider Adapter boundary.
