# AGENTS.md - AI Agent Development Guide

> Chinese version: [AGENTS.zh_cn.md](./AGENTS.zh_cn.md)

This document is for AI agents and contributors working on Farming. It describes the product intent, engineering boundaries, repository layout, and verification expectations.

## Product Overview

Farming is a browser-based workspace for supervising AI coding agents. It focuses on the user's attention: when several agents are running at once, the interface should help the human notice what matters, intervene at the right moment, and avoid bouncing between SSH terminals, IDE windows, browser tabs, and monitoring pages.

The current public product line is **Farming 2**, whose default skin is **Farming Code**. It combines remote terminals, Codex / Claude Code sessions, project files, file search, Monaco-based light editing, git blame, usage signals, and machine status in one browser page.

The browser serves Farming Code at `<base-path>/code/` and the original live CRT UI at `<base-path>/crt/`; the base-path root remains a compatible Code entry. Both UIs connect to the same backend sessions. Code startup and render failures should reveal the live CRT UI behind a bounded diagnostic overlay, without restarting or duplicating Agent processes.

**Farming Net** is a separate, lightweight deployment directory. It runs with its own base path, config directory, token, cookie, and Ed25519 signing identity. Enrolled targets exchange a target-bound, short-lived, one-time signed pass for their own normal cookie; the portal must never store or expose target tokens. Real deployment registries are private operational configuration and must not be committed.

Longer term, Farming explores a Main Agent workflow: a supervising agent can observe other agents, organize work, report progress, and reduce context switching for the human operator.

## Design Philosophy

Farming assumes:

- human attention is limited;
- humans do not truly multitask;
- users dislike being nagged, but appreciate useful reports;
- observing work in progress can be satisfying when the state is clear;
- every important operation should be reachable by keyboard.

Avoid:

- dense information dumps;
- putting every possible state on screen;
- noisy notification dots;
- static screens that look dead.

Prefer:

- clear project and agent grouping;
- visual feedback for every action;
- compact controls that match their content;
- stable, non-jumping layouts;
- fail-fast behavior for core terminal / PTY paths instead of low-quality fallbacks.

## Documentation Rules

When repository structure or behavior changes, update the relevant docs in the same change:

- `README.md` for user-facing project overview and setup;
- `AGENTS.md` for AI-agent development instructions;
- `docs/products/*` for product-specific design and verification notes.

The README is a product entry point, not an implementation history. Update it only when the top-level product promise, primary setup, or first-use path changes. Do not add state machines, cache layouts, dependency plumbing, bug-fix details, or release notes there; keep those in the relevant product document, engineering guide, or release notes.

`docs/README.md` is the public documentation hub. Keep it as a short direct index
to real task and product pages; do not add a category page until it has enough
content to justify another navigation step. Every `docs/products/*/README.md` is
a short product landing page, not the complete design record.

For public documentation, the default Markdown file should be English. Keep the Simplified Chinese version beside it with the `.zh_cn.md` suffix, for example:

- `README.md`
- `README.zh_cn.md`
- `docs/products/code/browser-agent-cli.md`
- `docs/products/code/browser-agent-cli.zh_cn.md`

Each English document should link to its Chinese version near the top. Each Chinese document should link back to the English version.

Do not maintain public conversation logs. Ordinary Q&A, temporary debugging, and transient implementation notes should not be written to public docs. Important product, architecture, or interaction decisions should go into the appropriate durable document.

Implementation documentation should explain durable concepts: architecture and component boundaries, design rationale and tradeoffs, user stories, authoritative state ownership, state transitions, safety and liveness invariants, failure and recovery semantics, and verification strategy. Do not mirror incidental source-code structure such as private function names, field lists, temporary file layouts, or step-by-step control flow unless it is a stable interface that operators or integrations must rely on. Keep exact implementation mechanics in code and tests.

## Engineering Principles

- Keep changes scoped to the request.
- Only npm installations support in-app self-update. Source, app-bundle, and standalone installations use their own manual deployment path; the Server must never fetch GitHub Releases as an update source.
- Prefer existing patterns and local helpers.
- Avoid premature abstraction in prototype surfaces.
- Validate user input and return actionable errors.
- Do not hard-code secrets or private environment assumptions.
- Codex transcript/chat rendering must pass user-visible text through the shared backend sanitizer for Codex internal envelopes; when Codex changes injected context formats, update that sanitizer and its tests in the same change.
- Keep agent processes isolated.
- Use asynchronous IO for server paths.
- Cache heavy filesystem / CLI scans with stale-while-refresh behavior where the codebase already does so.
- Distinguish background navigation data from an explicit current-state view. Background data may be prefetched for sidebars, counts, and routing, but opening a page that claims to show current capability, inventory, configuration, or health must invalidate the previous presentation, show a bounded loading state, and obtain a new authoritative backend result. A cache may accelerate that backend read only when its freshness is proven by the owning subsystem; the frontend must never present a previous visit's snapshot as the answer to the new request. Failure remains explicit and must not fall back to the old snapshot.
- For every non-trivial feature, derive a minimal state-transition model from the known business requirements before implementation. Identify the authoritative state owner and define each transition's trigger, guard, effect, failure result, and retry / cancellation / concurrency / recovery semantics.
- Treat correctness as both safety and liveness. Safety means unintended bad states are unreachable and every transition preserves the required invariants. Liveness means that, under explicitly stated external assumptions, every transient state has a bounded success, failure, cancellation, timeout, or recovery path and the intended good state is eventually reachable.
- Simplify state machines before adding abstraction: merge behaviorally equivalent states, remove business-meaningless intermediate states, keep one source of truth, and reject illegal transitions at the boundary. After correctness is established, evaluate whether the design is easy to prove, cohesive, loosely coupled, hard to misuse through its API, and clear to operate through the UI.
- Continuous test capacity is finite. Do not add a fallback product path unless it can be exercised continuously with the same acceptance bar as the primary path. An untested fallback is unsupported behavior, not resilience; prefer one explicit path with a visible bounded failure. Recovery and retry may stay inside that supported implementation, but must not select a second implementation. Diagnostic alternatives must be manually selected and remain outside the product support contract. If an alternate path becomes necessary, either make it the primary path or fund equivalent continuous coverage before shipping it.
- Add or update tests in proportion to risk.
- Tests and ad-hoc reproductions must clean up every temporary directory, socket, process, and fixture they create, including failure and cancellation paths. Use `try/finally` or the test framework's owned teardown and target the exact identity created by that test. Do not leave test garbage behind, and do not compensate with a broad cleaner that scans or recursively deletes generic paths such as `/tmp/farming-*`.
- Use small synthetic fixtures only for the first smoke pass. Before accepting a non-trivial UI or runtime change, exercise information-rich real or production-shaped scenarios that combine the relevant surfaces—for example long Agent transcripts, tool activity, Markdown, code, images, live xterm output, theme changes, and lifecycle transitions. Prefer a few representative complex scenarios that expose interactions over many isolated toy cases, while keeping deterministic regression tests for each defect found.
- The pinned Codex ACP patch must advertise both the reviewed `_codex/session/steer` extension and standard `session/fork` backed by Codex `thread/fork`; release smoke must fail if either negotiated capability disappears.
- When an ACP provider's forked Session exists only in the adapter process that created it until the first child Prompt, create the Fork inside the new child Agent's isolated adapter after loading the revision-fenced source there, close that temporary source Session, and keep the exact child identity on that process. Pass the exact fenced binding checkpoint—including bounded child transcripts and committed patch decisions—privately into that startup and install it under the returned child identity after Fork succeeds, so provider replay lag cannot replace the clicked transcript revision or discard its tool state. A pre-Prompt process loss must fail visibly rather than silently re-fork, and startup rollback must prove the child process stopped before deleting the exact Fork identity. If provider deletion fails, retain and report that exact identity for operator cleanup rather than losing it behind a generic error.
- Preserve visual style when fixing behavior unless the user explicitly asks for a visual change.
- Do not add, remove, or rewrite visible product copy without a clear product reason.
- Code sidebar Resource sections must compose the shared `code-sidebar-resource-*` presentation contract. Core owns section headers, row geometry, hover / active / focus states, action reveal surfaces, action-button sizing, and empty rows; Browser, Computer, and future Extensions may vary icons, labels, status semantics, and available actions, but must not fork those interaction styles in Extension-local CSS.

## Architecture

```text
Browser skins
  React + Vite + Monaco + terminal renderer
        |
        | HTTP / WebSocket
        v
Farming core
  Express server + token auth + agent manager + session providers
        |
        | native pty host + session engine
        v
Execution environment
  bash / zsh / Codex / Claude Code
```

The backend owns lifecycle, auth, session routing, terminal IO, workspace file APIs, session history, usage collection, and configuration. Frontend skins organize these capabilities into product experiences. New interactive sessions use `NativeSessionEngine` by default: Farming keeps node-pty agent processes in a separate native pty host process, so the browser and Farming server can reconnect to live terminals. The native pty host persists across Farming server restarts unless `FARMING_NATIVE_PTY_HOST_PERSIST=0` is set, then exits after an idle grace period once no live sessions or clients remain. `LocalSessionEngine` remains available through `FARMING_SESSION_ENGINE=local` for focused debugging, but product runtime work should target the native pty host path.

The Farming Server lifecycle is crash-only. SIGINT and SIGTERM must retain their immediate process-exit semantics; do not install a Server signal handler that calls `AgentManager.dispose()`, waits for Agent operations, or publishes a partially shutting-down state. Manual stop, deploy restart, and update verify the exact Server process identity, send SIGKILL, and wait only for process exit plus port release. An `EPERM` or `EACCES` signal result proves the process may still exist: do not mutate the package directory, and report that the owning OS user or an administrator must restart Farming before retrying the update. Startup recovery and reconciliation, not pre-exit draining, own correctness. An active provider turn may be interrupted and later resumed by that provider; Farming persists and recovers only Farming-owned state.

One canonical `FARMING_CONFIG_DIR` may be used by only one Server. Different Config directories isolate Farming-owned state; project directories and configured Provider Homes remain external shared resources.

The Browser Resource module lives under `extensions/browser` and is disabled by default. When Browser is enabled at an ACP Session boundary, Farming automatically projects its complete `browser_*` MCP catalog through the Provider Adapter; Terminal access remains on demand through the CLI. Its one supported operations and Viewer runtime is the exact `agent-browser` version declared by Farming's startup-dependency manifest. Farming must not reimplement browser automation with raw CDP, add Playwright or Puppeteer to its production package, ship Chromium inside the release, add WebDriver, or keep a silent second implementation. Before a fresh Server opens its port, the Farming launcher always prepares and uses the verified immutable `agent-browser` cache entry; it must not reuse or fall back to a system installation. Chromium is a separate opt-in dependency: never download it during normal install, update, or startup. **Plugins → Browser** exposes named discovered local Chromium executables and an always-visible Isolated Browser source; it does not expose raw CDP configuration to ordinary users. Farming persists the first compatible local executable as the initial selection. If the selected executable disappears, Browser becomes visibly unavailable and never silently switches to another local or isolated source. Preparing Isolated Browser is an explicit action, shown with a Docker requirement when Docker is unavailable, that prepares the exact pinned Computer image and downloads a verified Linux Chromium cache for that container; Farming does not maintain its own Browser or desktop image. The isolated runtime uses the Agent's one visible Computer container, mounts the managed Chromium cache read-only, publishes CDP only on loopback, and gives that internal endpoint to the same pinned `agent-browser` runtime. Multiple Browser Resources owned by that Agent remain labeled tabs in one shared Browser Session and one Computer desktop. Browser Stop closes tabs and the `agent-browser` Session but does not hide or delete the Agent-owned Computer; the Agent lifecycle owns that container. A Server restart removes only exact legacy hidden Browser containers before Browser recovery. User-supplied external-CDP settings remain a read compatibility path, not a primary UI choice. Changing the visible Browser source must validate the desired source, stop every owned running Browser, and only then commit settings; a cleanup failure keeps the previous selection. A stale Viewer generation is rejected; the authenticated Viewer proxies the runtime's JPEG WebSocket stream and maps pointer, keyboard, wheel, and viewport input back to that same Session. Browser actions and Runtime commands are both serialized; Stop closes new admissions, drains already admitted bounded actions, and only then closes the corresponding tab. The supported Agent surface covers navigation/waits, DOM interaction, structured inspection/JavaScript, console/error/network evidence, cookies/storage, frames/dialogs, and Project-scoped upload/download; tabs map to separate Farming Browser Resources. Codex, Claude Code, OpenCode, and Qoder receive the Farming bootstrap from `backend/farming-agent-bootstrap.zh_cn.md` at startup and discover live capability state through `farming capabilities`. Enabled Browser capability is also projected automatically into newly created ACP Sessions; `farming browser` is the on-demand Terminal bridge to the same Browser identity, `farming browser mcp` is the stdio transport behind the Provider Adapter and explicit manual integrations, and `farming-browser` is only the npm bin alias. CLI discovery must remain progressive: Farming's global help advertises only the Browser entry, Browser top-level help advertises start points and topics, topic help reveals one capability domain, and only command help reveals exact arguments.

Computer image acquisition may use Docker's configured registry mirror, including an account-scoped Alibaba Cloud accelerator; those mirrors remain deployment configuration rather than Farming image URLs. Chromium download candidates are probed with bounded timeouts and tried in measured-latency order. Because Chromium binds CDP inside the Computer to loopback, the provider uses an internal relay and publishes only that relay on host loopback. Enabling Isolated Browser also keeps Computer enabled, because the visible Computer Resource is the authoritative container and desktop owner. On legacy Linux, only the `agentBrowser` startup dependency switches to the statically linked musl artifact from the same exact npm package; Codex and Claude retain their normal platform artifacts. The active dependency record must retain each dependency's selected platform key so pruning cannot delete the live musl cache.

Each Farming page uses its one versioned main WebSocket for Chat, Terminal, and lightweight Browser / Computer Resource metadata. After protocol negotiation the Server sends authoritative full Resource snapshots, repeats them after every reconnect, and then sends revisioned per-Resource updates coalesced by identity. Capability probes and lifecycle mutations remain bounded HTTP requests. Browser JPEG and Desktop noVNC streams remain separate on-demand WebSockets and must never enter the main control connection. Do not add Browser- or Computer-specific EventSource connections. Foreground current-state reads take priority over background navigation: opening a Terminal must synchronously abort in-flight low-priority usage and Agent-session prefetches before its authoritative `/session-view` checkpoint is requested.

Terminal display recovery is a checkpointed state-machine protocol. The native PTY host's headless xterm instance is the authoritative reducer. Each PTY runtime has a unique epoch; output transitions advance both `outputSeq` and `stateRevision`, while clear and resize advance only `stateRevision`. A serialized checkpoint must carry the exact epoch, sequences, screen, and dimensions committed by that reducer. WebSocket coalescing must preserve individual transition indexes. The browser validates every index in a coalesced message, but submits each contiguous output / clear run to xterm as one write batch. Resize remains an ordered batch boundary; after committing it, the browser holds its following redraw until short bounded output quiescence, then paints the burst once so a full-screen TUI redraw is not exposed chunk by chunk. A browser may apply only the next contiguous transition for its current epoch; duplicates are ignored, while gaps, epoch changes, hidden-page suspension, and reconnects require an authoritative `/session-view` checkpoint before live reduction continues. Do not poll `/session-view`; retry transport failures with backoff, and stop visibly when repeated responses violate the same checkpoint invariant. Never paint a checkpoint known to be behind the current replay target, and suppress incremental xterm painting while installing a full checkpoint so recovery appears as one latest screen rather than historical playback. On PTY exit, wait for a 250 ms trailing-data quiescence window, drain the reducer, and preserve an exact final checkpoint. A missing or non-exact final checkpoint is a visible fatal state-proof failure, never a raw-output fallback presented as an authoritative screen.

Terminal browser attachment is an ownership state machine, not a React effect lifecycle. Its identity is exactly Agent id plus mount element. Effect cleanup enters a microtask-bounded `release-pending` state; a same-owner reacquire cancels that release without detaching, advancing the attachment generation, or entering checkpoint recovery. A different Agent or mount releases the old owner before attaching the new one, and stale leases cannot release a newer owner. Duplicate same-owner calls at the Session Pool boundary must also be idempotent. Callbacks, input enablement, cursor suppression, and bootstrap data are live options updated independently of attachment ownership.

Terminal input remains a direct raw PTY stream: do not add per-input ACK, deduplication, automatic replay, or timing-based textarea fallbacks around xterm `onData`. Multiple Code / CRT viewers share one authoritative display and may all write; the AgentManager input queue serializes accepted input in server arrival order. There is no browser controller lease, takeover UI, renderer ACK protocol, or viewer-count UI. An ambiguous transport failure never automatically replays input. Geometry means only display dimensions (`cols` and `rows`). All browser-layout-driven geometry changes are trailing-coalesced as one complete `cols + rows` update so a sustained window drag cannot repeatedly reflow xterm and retrigger a full-screen TUI redraw. Do not branch this behavior on renderer buffer type or output length; TUI alternate-screen state makes that classification unreliable. Explicit attach, recovery, and forced fits remain immediate. The backend keeps at most one in-flight resize plus the latest pending size. Reducer backlog alone drives PTY high/low-watermark flow control, and a slow browser is isolated by WebSocket backpressure instead of pausing the shared PTY. The native PTY host's controller generation remains an internal server-process handoff boundary: it closes old admissions, drains every already-admitted mutation, and only then publishes the new server generation. It is not browser ownership.

Browser-facing Agent state has four explicit domain boundaries. `runtimeBinding` is the tagged runtime contract (`terminal`, `acp`, or `json`); legacy flat runtime fields remain an internal persistence compatibility shape and must not leak back into clients or new feature code. Persisted experimental Codex `app-server` bindings are unsupported and must not restart or recover an App Server process. `runtimeObservation` is the backend-owned current-runtime classification consumed by UI; frontends must not re-infer it from terminal text, and Server stop/restart/update must not use it as a lifecycle guard. Provider-specific executable, session planning, runtime support, home environment, and normalized capabilities belong in `ProviderAdapter`, so generic lifecycle/UI code reads capabilities instead of provider-name lists. Project Files HTTP APIs use `WorkspaceRoot.rootId`; the old `agentId` form is a read compatibility adapter only. Code and CRT WebSockets negotiate and validate the shared versioned browser protocol before processing messages. WebSocket ping/pong proves only transport liveness and may terminate a dead socket; the user-visible backend health state comes from a bounded request/ack that traverses browser-protocol validation, normal message dispatch, startup recovery, and the authoritative AgentManager state read. Terminal input remains exempt from command ACK/replay semantics.

Agent Create, Update, Delete, Archive, and Fork use the private `agent_*` metadata record's lifecycle journal as their write-ahead metadata history. Persist intent before external side effects, serialize or join conflicting operations, and persist a terminal result afterward; every external mutation waits for startup recovery to finish. Runtime-confirmed Create enters `membership-pending` before main-page membership commits. Fork request ids are durable on the source Agent, child records retain the same private request id, and a lost result is reconciled only from exactly one matching child. Codex Archive remains non-terminal through `provider-archive-pending`; provider failure is blocked and retryable instead of being logged after local success. Restart recovery consumes non-terminal journal entries without launching a duplicate runtime. ACP process startup is gated until its exact process-group identity is durable, and cleanup must prove that identity exited. Upgrade recovery must remain compatible with ACP records created before process identities existed: once the new Farming server owns startup, resume their exact provider Session through the normal ACP load path instead of requiring per-Session operator acknowledgement. Newly started ACP processes must immediately persist the precise process-group identity used by all later cleanup. JSON CLI Chat is removed; runtime requests must resolve only to Terminal or ACP Chat.

Browser HTTP commands use local admission and request ownership, not a shared transaction framework: capture the Agent, workspace root, file, dialog-open generation, or session generation before the first asynchronous boundary, and let only that same owner commit loading, data, focus, or errors. Main-page provider-session membership is changed only through atomic add/remove commands; generic Settings writes must reject the compatibility projection, and Settings clients submit only changed fields. Permanent-worktree Create and Farming-worktree Delete persist a private bounded operation in the same Settings snapshot that owns Project membership. Git success is reconciled from the exact directory, branch, and `git worktree list --porcelain`; terminal operation state and membership commit in one snapshot, while UNKNOWN is never replayed automatically. Long backend transitions are serialized at the resource that owns them: Review refreshes by review id, Codex archive/unarchive by Agent Home plus provider session, and worktree deletion by canonical workspace. Worktree deletion closes new starts for that workspace, drains its already-admitted starts with a bounded wait, proves every Agent stopped, and only then removes the directory. Workspace watcher initialization and each WebSocket watch command use single-flight ownership; a cancelled, disconnected, or replaced initialization closes any watcher or subscription it created before it can publish itself.

Project Files use a filesystem-authoritative optimistic working-copy model. Browser drafts carry a monotonic revision; an in-flight save may mark the working copy clean only when that exact revision is still current, otherwise it updates the disk baseline and preserves the newer draft as dirty. Dirty drafts are checkpointed after a short debounce into a bounded browser-local backup and flushed on page hide; reopening the same file restores that draft, while an already-committed identical draft is discarded as clean. The backend serializes mutations per canonical workspace, rechecks file content versions inside that queue, creates temporary files exclusively with unique names, attempts `datasync` before close, and atomically renames completed content into place. Duplicate saves of the same desired content are idempotent. Directory entries carry a filesystem-derived version that rename, move, and delete requests may require; file creation uses create-if-absent. Browser Create, Rename, and Delete operations capture a monotonic UI generation and reserve that generation synchronously before starting the request, so repeated Enter or click events cannot submit it twice. Cancellation, replacement by a newer operation, a Files root change, or unmount revokes only the old generation's UI ownership; a late response may still refresh its authoritative directory and propagate proven move/delete effects, but it must not clear newer UI, show a stale error, open a file, or steal focus. Mutation requests stop waiting after 15 seconds and treat that timeout as an uncertain outcome; reconciliation uses a fresh bounded authoritative read and never replays the mutation automatically. After an authoritative parent reread, create may converge to success only when the exact expected path exists with the requested type, delete may converge to success when the source is absent, and rename may converge to success when the source is absent and the expected same-type target exists. This proves only the desired current filesystem state, not which process caused it. Watch events remain invalidation hints and never become authoritative state. These guarantees cover Farming-originated operations in one server process. Other Farming servers and arbitrary external writers are ordinary independent filesystem clients outside that serialization domain and must converge through conflict detection and rereading; do not claim cross-process transactions, exactly-once operation attribution, or power-loss durability. `datasync` is best-effort and the parent directory is not synced.

Routine per-Agent terminal metadata changes use the protocol's whitelisted `agent-update` patch rather than broadcasting the full workspace state. This patch channel is closed to arbitrary Agent fields and may carry only terminal input, shell status, terminal status, and runtime-observation metadata. Reconnect and initial hydration still use the authoritative full state.

Both browser skins default to xterm.js, and WebGL is the single supported product renderer. WebGL activation failure or unrecoverable context loss must stop visibly; do not silently switch a live terminal to the DOM renderer. The Ghostty web renderer remains available only as an explicit debug path via `localStorage.farmingTerminalEngine = 'ghostty'` and is not a product fallback.

Packaged native-addon extraction must compare existing bytes and use atomic replacement. Node-pty calls its native loader more than once; truncating an already mmap'd Linux `.node` file causes the first `pty.fork` to segfault even though the extracted checksum is correct.

For Codex, Claude Code, OpenCode, and Qoder, Farming Code's structured Chat runtime uses ACP. Codex uses the pinned `@agentclientprotocol/codex-acp` package as its only structured Chat path, with a small version-locked Farming patch that advertises `_codex/session/steer` and forwards it to Codex `turn/steer`; Codex-specific behavior belongs at this adapter boundary, not in a second lifecycle or UI implementation. Apply the patch fail-closed before packaging, copy the reviewed adapter into the release as a version- and SHA-256-locked runtime artifact, and launch that artifact without mutating installed dependencies. The standalone CLI must bundle the same adapter behind an internal process entry because its self-contained executable is not a general Node interpreter; native artifact smoke must complete an ACP `initialize` handshake through that entry. Remove the patch when an equivalent negotiated ACP capability is available upstream. The Chat / Terminal control restarts the Agent into ACP or the native PTY runtime and resumes the same provider session; it is not a view-only toggle. A fresh OpenCode Terminal first creates the provider session through a one-shot ACP `session/new`, validates and persists the returned stable id, then launches the native PTY runtime with that exact resume id. Identity creation or one-shot process cleanup failure aborts the Terminal start visibly. Rollback must first prove that the one-shot ACP process tree has exited and only then delete the exact provider session; if process exit cannot be proven, retain the exact private identity without deleting it, and if deletion fails, carry that identity so the lifecycle owner can retry safely. Treat Terminal creation errors as an uncertain outcome: issue an idempotent runtime kill and prove that the engine reports the session exited or missing before deleting the provider session. A fresh Codex Terminal instead starts the native PTY immediately with a temporary correlation id because Codex does not persist a new rollout at `session/new` time. The stable Farming `agent_*` record, never that temporary provider id, owns project membership, pinning, title, and recovery metadata. Temporary ids must not enter main-page provider membership, and native-host recovery of a temporary Agent must use the `agent_*` record's `visibleOnMainPage` intent rather than reconstructing a temporary provider key. Farming may replace a temporary Codex id only when provider history yields exactly one unclaimed candidate in the same Agent Home whose canonical workspace and trustworthy `createdAt` fall inside the bounded launch window; time is an eligibility bound, never a nearest-candidate selector. Recheck ownership synchronously when committing the binding so concurrent Agents cannot claim the same rollout. Ambiguous, linked-worktree-only, stale, updated-only, or future matches remain temporary, and Farming must never use `--last`. Once the exact provider id is confirmed, map it onto the existing `agent_*` record and use it for runtime switching, Fork, and resume. A temporary Terminal with no user input may still switch directly into a fresh ACP Chat; Fork requires an exact provider id. Mark submitted Terminal input as used before awaiting the PTY response, because a failed response does not prove that the PTY rejected the input. Once Terminal input has been submitted, keep the resumable-session guard for Chat, permission restart, and Fork so a missing or ambiguous history record can never silently discard a conversation. Standard ACP `additionalDirectories` and `mcpServers` belong to the session-start boundary, survive runtime replacement and recovery, and must stay out of browser-facing Agent state; any persisted copy belongs only in the private session record. Outbound media must be sent natively only when the live Agent advertises that prompt capability, with an explicit readable fallback otherwise.

An accepted Codex steer is a Farming-owned transcript transition, not an optional adapter echo. After the exact steer request succeeds, the ACP runtime records its user content at the admitted position with the generated client message id; an adapter echo that arrived before the response prevents the local insertion, and an echo that arrives later reconciles with that same optimistic entry by id. A rejected or ambiguous steer must not create this accepted transcript entry.

Release packages carry the exact reviewed Codex and Claude ACP JavaScript runtimes, but must not carry the transitive platform Agent CLIs from `@openai/codex-*` or `@anthropic-ai/claude-agent-sdk-*`. The npm package bundles its complete production dependency tree from the exact lockfile so a global install does not require dependency lifecycle-script approval. npm 12 rejects bundled trees that still expose root-only `overrides`; the npm release packer must therefore install the locked production tree in an isolated staging directory, verify and rewrite every reviewed overridden dependency edge to the exact selected version, remove only the staged root `overrides`, and pack that internally consistent tree without mutating the checkout. Its release smoke must install that exact packed tarball into an empty prefix and cache while npm is offline and using its default script policy, fail on any `allow-scripts` warning, and then exercise the packaged runtime. Codex CLI, Claude Code CLI, and `agent-browser` are startup dependencies rather than production package dependencies. One checked-in manifest pins each supported platform artifact, source URL, integrity, executable entry, and expected version from exact package-lock records. Startup artifacts must come from public npm registry tarballs; direct GitHub or vendor release URLs are unsupported. Installation and update preparation download, verify, stage, and atomically activate missing cache entries while the old Server remains live, then may enter the restart window only after success. A fresh installation without a separate preparation phase may perform the same work immediately before its first Server start. Every Server start revalidates the exact cache before opening its port and may repair a missing or invalid entry as a safety gate, but normal upgrades must not defer downloads into the restart window. A fresh launcher may reuse an exact-version system Codex or Claude executable; `agent-browser` is always extracted from its pinned npm package into and launched from Farming's verified immutable cache. Download progress belongs to the dependency manager's event stream: interactive CLIs render one throttled in-place line, non-TTY logs emit bounded milestones, cache hits remain silent, retries and verification are explicit, and renderer failure must never affect download correctness. HTTP `Content-Length` is display-only; pinned integrity remains authoritative. The prepared environment supplies `CODEX_PATH`, `CLAUDE_CODE_EXECUTABLE`, and `FARMING_AGENT_BROWSER_BIN` to runtime consumers. Concurrent preparation shares one lock, corrupt cache entries are replaced without becoming active, and a failed preparation must leave the currently running Server and package untouched with an actionable error. npm, bundle, and source deployments run the new release's dependency preparation before stopping the old Server and may become `ready-to-restart` only after it succeeds. Only after the new Server is listening may it prune dependency cache entries not selected by its active manifest; cleanup failure is visible but does not turn a healthy Server startup into failure. Package smoke must prove that both vendored adapters complete ACP `initialize` with platform packages absent from the release.

Each prepared runtime manifest also owns an atomically written platform-specific binding under `runtimes/bindings`; `active.json` identifies only the binding used by the running release. Update, bundle, and source-deploy preparation must use `runtime prepare --no-activate`, so preparing a new release cannot replace the old Server's active binding. The installed launcher activates its own exact binding before opening the port, and rollback naturally reactivates the old release binding. Pruning retains the active binding plus the two newest prepared or rollback bindings and derives every kept cache directory from those binding records rather than from the currently executing package manifest alone.

Live Codex Terminal model changes must follow the CLI's rendered `/model` and reasoning menus and confirm the resulting footer before releasing later Composer input. Do not automate the TUI with fixed delays or assume catalog indexes match the visible menu. `/fast` is a non-interactive toggle command: once its complete input is accepted by the PTY, release later Terminal input while confirmation continues outside the input queue. Fast / Ultra controls remain visible but disabled when the active runtime catalog does not advertise them.

ACP history replay and live updates must reduce into the same ordered entry stream. Do not introduce a backend `Turn -> Item` reconstruction for ACP. User-facing result/process grouping is an ACP frontend attention projection: it must remain reversible, preserve entry order and tool details, and hide Codex internal heartbeat/context activity without deleting visible automation notifications.

Provider adapters must translate provider history into standard ACP content blocks. Farming reducers must not reopen provider rollout JSONL to reconstruct transcript text or media; unavailable provider content stays explicitly unavailable. Direct provider-history parsing is reserved for bounded metadata discovery or usage accounting until an authoritative provider API replaces it.

Codex collaboration activities are evidence, not child lifecycle state. The version-locked adapter owns descendant reconciliation through app-server spawn-edge queries and authoritative child turn outcomes, then publishes versioned snapshot/delta metadata for the Farming reducer to checkpoint. Frontends may show `subAgentActivity` inside the matching child disclosure, but must never infer running, completed, interrupted, or failed from an activity verb or parent tool-call completion.

Farming Code keeps the logical opened-Agent order separate from a bounded frontend view cache. Chat DOM and pooled xterm instances share one twenty-Agent LRU working set: activating an Agent makes it most recent, the active Agent is never evicted, and opening a twenty-first retained view releases the least-recent inactive Chat DOM or xterm instance without stopping its backend ACP or PTY process. Switching among retained Agents, or temporarily opening Search, History, or a file, hides rather than evicts those views. A retained Chat paints its transcript and reading state before revision-based ACP reconciliation; an evicted Chat reloads the authoritative transcript, while an evicted Terminal rebuilds from the authoritative session-view checkpoint. Closing, archiving, or killing removes the view immediately, and runtime replacement remaps the retained identity.

ACP transcript reconciliation must never blank or regress already visible content. Each frontend read owns a monotonic request generation, and only the latest generation may mutate transcript, loading, or error state. Within the same provider Session, a response whose revision is lower than the displayed revision is stale and must be ignored even when the HTTP request completed successfully; refresh and reconnect keep the current transcript visible while reconciling.

ACP recovery may skip full `session/load` only from an exact, atomically committed Farming reducer checkpoint whose provider, Agent Home, session, workspace, and provider freshness still match. Fence the checkpoint dirty before a prompt; missing, dirty, stale, corrupt, or unverifiable state must visibly remain on the bounded load/repair path. Transcript pages carry compact ordered tool envelopes, while exact raw tool detail remains backend-owned and lazy-loaded by tool-call id. External transcript media requires explicit rolling-upgrade-safe client negotiation and immutable content-addressed URLs; stale identities fail closed. Bounded automatic transport retry is allowed only for the read-only transcript GET and must never replay prompts, terminal input, or another write.

Qwen Code follows the same ProviderAdapter-owned ACP Chat and Terminal lifecycle as the other supported coding agents. It uses the system `qwen` executable and `QWEN_HOME`, injects the Farming bootstrap, scans only resumable root transcripts under `projects/*/chats`, and must not advertise Fork until the live ACP Agent negotiates standard `session/fork`.

Current Browser ownership and capability-projection rules replace the earlier Project-shared/on-demand-MCP wording: a Browser opened by an Agent is owned by that stable Farming Agent record, while `projectRootId` remains only its workspace isolation boundary. Browsers owned by the same Agent and Browser source may share one `agent-browser` Session as separate tabs; different Agents must never share that Session, profile, cookies, or storage. Chat/Terminal runtime switches retain Browser Resources. Agent stop or archive stops owned Browser runtimes but retains rows and profiles for on-demand resume; Agent deletion stops and removes the exact owned Resources and profiles. The sidebar hides Resources by default under **Agent → Resources → Browsers**; expanding or collapsing either layer must not affect runtime or Viewer state, and Agents with no Resources show no toggle or zero count. When Browser is enabled at an ACP Session boundary, Codex, Claude Code, OpenCode, and Qoder receive Farming's complete granular `browser_*` MCP catalog through their existing Provider Adapter; `browser_open` creates, mounts, and starts an Agent-owned Resource. Terminal Agents use the progressive `farming browser` CLI as a transport to the same contract. Enabling Browser after an ACP Session has started requires a visible Chat runtime restart before advertising the tools. Every Agent operation is fenced by exact owner, Project root, Resource generation, Session generation, tab id, and running state; stale calls fail visibly. Legacy Project-owned rows may remain persisted and visible as Project Resources, but new Agent workflows do not silently share them. Browser uses the Provider's Agent Session permission mode and adds no independent plugin permission policy. If the Provider asks and the user grants a Browser request for the Session, Farming reuses that grant for later Browser tools on the same origin; a new origin asks again. Provider Full access / skip-permissions may bypass ordinary Browser approval. The active Agent's Chat may show a fixed-size passive preview of its latest running Browser; it may consume frames but must never send Viewer input or viewport messages, resize content, or affect Browser lifecycle, and dismissing it only hides that generation.

The experimental Computer module lives under `extensions/computer`, is disabled by default, and owns Farming's Docker boundary. Its full-desktop Resource uses the exact upstream `trycua/xfce-cua` image digest and Cua Driver version pinned by Farming. Isolated Browser reuses that same visible Agent-owned Computer and mounts explicitly prepared managed Chromium into it read-only; there is no second hidden Browser container. Farming must not maintain its own desktop or Browser image or silently substitute another image or driver. Image pulling and Chromium download are explicit prepare actions, never install/update/startup dependencies. Older Docker seccomp compatibility is an explicit user setting used only after a visible probe failure. A stable Agent record owns at most one Computer Resource and exact labeled Docker container; different Agents never share its desktop, driver Session, Viewer credential, Browser profile, or CDP endpoint. Chat/Terminal switches retain it, Agent stop/archive stops but retains it, and Agent deletion removes the exact verified container and Resource. An inactive or archived Agent cannot restart its Computer. The Server exposes no Docker socket to the container, publishes noVNC and the Browser CDP relay only on loopback, and proxies user-facing access through authenticated routes. Agent control admits only tools in the complete pinned granular `computer_*` catalog at an ACP Session boundary or the progressive `farming computer` CLI; arbitrary upstream Cua tool names must fail before Docker. Human takeover and Agent control are mutually exclusive epochs. A control transition first closes new tool admission, drains admitted bounded actions, advances the epoch, and closes stale Viewers. Returning control to the Agent requires a fresh desktop, browser, window, or accessibility-tree observation before mutation; metadata-only reads do not clear that fence. Actions serialize; Stop, Delete, and Reset close new Start/tool admission and retain that fence through exact container removal; while a Browser Session leases the Computer, direct user Stop/Delete must fail visibly. Stale generations fail, and timeout means uncertain outcome with no automatic replay.

## Repository Layout

```text
farming/
├── README.md
├── README.zh_cn.md
├── AGENTS.md
├── AGENTS.zh_cn.md
├── LICENSE
├── .gitattributes
├── bin/
│   └── farming
├── backend/
│   ├── server.cts
│   ├── agent-manager.cts
│   ├── native-session-engine.cts
│   ├── native-pty-host.cts
│   ├── native-pty-host-client.cts
│   ├── local-session-engine.cts
│   ├── farming-session-store.cts
│   ├── run-history-store.cts
│   ├── shell-busy-integration.cts
│   ├── workspace-file-service.cts
│   ├── workspace-file-router.cts
│   ├── farming-app-cli.cts
│   ├── farming-net-server.cts
│   ├── farming-net-registry.cts
│   ├── farming-net-pass.cts
│   ├── storage-layout.cts
│   └── tests/
├── src/
│   ├── App.tsx
│   ├── components/
│   │   └── codex/          # Farming Code skin components and state helpers
│   ├── hooks/
│   ├── lib/
│   └── styles/
├── frontend/
│   ├── farming-net/       # Standalone token-protected deployment directory
│   ├── skins/
│   │   └── crt/            # Independent CRT entry, app, static effects, and bundled display font
│   ├── *.ts                # Authoritative classic browser terminal/session bridge sources
│   ├── *.js                # Generated classic-script compatibility runtime
│   └── vendor/
├── extensions/
│   └── browser/           # agent-browser-backed Resource, Viewer, and Agent CLI
├── docs/
│   └── products/
│       ├── code/
│       ├── crt/
│       └── net/
├── config/
├── scripts/
├── tests/e2e/
├── pkg.config.cjs
└── package.json
```

`releases/`, `dist/`, `dist-release/`, `.tmp/`, `reference/`, and `node_modules/` are generated or local-only paths and should not be committed.

`backend/data/runtime-dependency-sources.json` ships one default optional HTTPS public npm mirror alongside the authoritative registry. Preparation performs one bounded exact-version metadata lookup: only a mirror record with the same version and SRI supplies the download URL; otherwise Farming uses the authoritative URL. A later mirror download failure retries the authoritative URL. `FARMING_RUNTIME_NPM_MIRROR` may override that packaged candidate or use `off` to disable it. Mirror configuration must remain outside the immutable runtime manifest so changing a source candidate does not invalidate verified caches. Do not add latency probing, racing, or persisted mirror-selection state.

## Runtime Configuration

Farming stores runtime settings under `~/.farming/settings.json` by default. Backend-owned file locations under the config directory are centralized in `backend/storage-layout.js`; new config-dir files should go through that helper instead of hand-writing `path.join(configDir, ...)` in feature modules. Important user-facing settings include:

- `defaultLaunchAgent`
- `agentLaunchProfiles.codex`
- `agentLaunchProfiles.claude`
- `agentHomes` (the ordered global registry of Agent configurations currently enabled for fresh Agents: one `provider + home id` is one Agent and each record owns its canonical-unique Home path. Fresh Agents inherit provider configuration from that Home; Farming does not maintain per-Home model/reasoning/Fast overrides. The Plugins view may render a safe textual summary of recognized configuration fields, and Edit opens the provider configuration file in Farming's file editor. Each provider keeps a non-removable `default` home. Private `agent_*` records retain the immutable `providerHomeId + providerHomePath` binding for existing Sessions after a non-default configuration is removed. A referenced Home id must never be rebound to another path; History and recovery merge retained bindings rather than relabeling them.)
- `searchTimeoutMs` (shared timeout for Project Files search and Agent history search; defaults to 15 seconds)
- `workspaceHistory`
- `projectWorkspaces` (the persisted Projects membership; Agent, file, restored Project session, and Git-worktree entry points all add the same workspace identity, while only Remove Project deletes it)
- `pinnedProjectWorkspaces` (the ordered pinned-Project queue; pinned Projects render before ordinary Projects, a newly pinned Project appends after existing pins, and unpinning restores the ordinary Project order)
- `dangerouslySkipAgentPermissionsByDefault` (launch supported coding agents such as Codex, Claude, OpenCode, Qoder, Qwen, Aider, GitHub Copilot CLI, and Amazon Q with their provider-specific dangerous permission-skip flags by default)
- `browserExtensionEnabled` (disabled by default; when enabled, projects the Browser MCP catalog into newly created ACP Sessions, while Terminal access remains on demand through the CLI)
- `browserSource`, `browserExecutablePath`, and `browserExternalCdpUrl` (the Plugins-selected Browser source; external endpoints must stay on loopback)
- `crtSkinEffectsEnabled` (controls only the CRT skin's scanlines, mask, vignette, and infrequent scan beam; Farming Code must not read or apply it)
- `crtDynamicHeatEnabled` (disabled by default; lets the CRT skin apply activity-level classes for dynamic Agent colors and sizing)
- `crtTerminalFontSize` (the CRT opened-terminal text size in pixels, clamped to `10`–`20`; the default is `15`)

Farming Net uses `~/.farming-net` by default and must remain isolated from the main Farming runtime. Its `.session-token`, signing key pair, `instances.json`, and `farming-net-server.json` are private runtime files. The browser-facing registry accepts only HTTP(S) endpoints and removes credentials, query strings, and fragments; target tokens must never be exposed through the registry API. Federated passes use Ed25519, an exact instance-id audience, a maximum 60-second lifetime, and replay rejection. Targets opt in through `~/.farming/farming-net-trust.json`, exchange a valid pass for their own HttpOnly cookie, and immediately redirect to a clean URL. Use the `FARMING_NET_*` environment variables for the portal's port, host, base path, config directory, token, pass TTL, and explicit local-only auth disable switch.

Runtime session metadata lives under `~/.farming/sessions/`, not in `settings.json`. Farming assigns new persisted Agent records a stable `agent_*` id. Low-frequency identity, product, process-ownership, and lifecycle fields live in `agent_*.json`; ACP/attention/read state and bounded Composer admission records live in the matching `agent_*.state.json` sidecar and cannot override lifecycle or process identity. A Composer record stores only request id, content hash, state, compact result/error, and timestamps; `onSubmitted` is the provider-admission linearization point, and `intent` left after restart becomes UNKNOWN rather than being replayed. Legacy `fsess_*.json` records remain readable but are never rewritten: the first mutation creates an `agent_*` successor with `legacyRecordId`, and discovery suppresses the superseded legacy row. The live native pty `agent-...` id is stored as runtime metadata, while Codex / Claude provider session ids are stored as external correlation fields. `sessions/index.json` v2 owns only ordered main-page provider-session membership; Provider Session to Agent-record identity is derived by scanning Agent records and duplicate bindings fail closed. Version-1 indexes remain readable, `settings.mainPageSessionKeys` remains only an API compatibility projection, and Codex `tmp_uuid...` live ids must not enter persisted main-page membership. Provider sessions not listed there stay in History.

Farming-owned JSON snapshots construct and validate the complete next value, write it through an exclusively created UUID temporary file, `fdatasync` it, atomically rename it, and only then publish the new in-memory reference. Settings, Run History, Review state, Agent records, sidecars, and the Session index use this boundary. A failed write, sync, or rename must leave both the committed file and the store's in-memory state unchanged. This protects process-crash consistency; do not claim power-loss durability because parent directories are not synced.

Run/archive history lives in `history/runs.json`, not in `settings.json`. A run may keep an optional `customTitle` so an explicitly renamed Agent retains that display name when restored; older entries without it remain valid. Theme overrides live in `theme-settings.json` under the same config directory. Server control metadata (`farming-server.json`, `farming-server.pid`, `farming-server.log`), the startup token (`.session-token`), and native pty host logs also belong to the config directory layout. `farming stop` must verify the exact recorded Server identity, send SIGKILL, and may remove matching control metadata only after the process has exited and its recorded port can be rebound; timeout must retain the metadata and fail visibly. Release smoke that starts the native PTY path must opt out of host persistence, explicitly terminate the exact smoke Agent, and prove the Server, host, and child shell processes are gone. External provider histories such as Codex `~/.codex/sessions` and Claude history files are read-only integrations and should not be treated as Farming-owned metadata.

Codex and Claude token history is parsed by Farming's TypeScript usage scanner in a Worker and persisted in `history/usage-history-v2.sqlite3` through Node's built-in SQLite module. It has no Python runtime dependency. Codex cumulative-counter accounting and copied-prefix classification are adapted from commit-locked CodexBar 0.45.2; Claude assistant usage extraction and streaming message-id de-duplication are adapted from commit-locked cc-statistics 1.1.0. Keep exact upstream revisions, adapted files, scope, and MIT licenses in `backend/vendor/usage-parsers/` and `THIRD_PARTY_NOTICES.md`; Farming does not bundle either upstream application runtime.

The scanner persists a directory census, source queue, and per-file byte checkpoints. Cold discovery starts inside the scan budget, persists its directory work, keeps memory bounded to one directory plus fixed source batches, and never publishes partial provider totals. Steady refreshes reuse unchanged directory rows, audit recent files plus a fixed rotating batch, and therefore do not enumerate, sort, or `stat` every Session. Appends start at the committed offset, Codex archive/restore renames migrate the matching checkpoint by formal session identity, and destructive rewrites detected by the committed prefix and edge fingerprints rebuild only the affected source ledger. The first Codex `session_meta` owns rollout identity. Embedded different metadata identifies copied ancestry, whose cumulative prefix is suppressed until an owned-turn boundary; compact explicit forks use the first trustworthy last-token delta and preserve its raw cumulative baseline so a later total-only sample cannot recount ancestry. The monotonic CodexBar watermark and bounded exact-total set prevent high/low interleaved lineage counters from recounting gaps. Long-term usage stays in source/session/local-hour rows, the recent window keeps exact events, and Claude retains only compact message identities required for cross-file streaming de-duplication. Storage must not grow by one Codex row per token event. Incompatible schemas delete and recreate the database plus WAL/SHM sidecars; the former `cc-statistics-usage-v1.sqlite3` cache is disposable and removed automatically. Do not restore whole-history `rg`, Python subprocesses, duplicate parser paths, raw long-term Codex event rows, or whole-file reads on the refresh path.

Interactive runtime sessions default to the native pty host. The host uses a Farming-specific local socket derived from `configDir`, keeps PTY processes outside the Farming server process, and exposes recovery metadata to the server after restarts. By default, Server process loss preserves the host for restart recovery; after the last live session and client disappear, the host shuts itself down after a short idle grace period. The server and host exchange a runtime code fingerprint when connecting. An application upgrade or fingerprint mismatch performs a transactional controlled rotation: block new mutations, drain and freeze the exact reducer cut, serialize every still-live Terminal, require a matching preparation token to stop the old host, and revive the serialized screen in a new PTY epoch. Serialization failure must resume the old host and abort rotation. A Codex Terminal that has accepted user input but still lacks an exact provider session id is likewise not restartable: abort the rotation and resume the old host instead of launching a fresh Codex process under the same `agent_*` record. An unexpected host crash is process loss and must never be presented as successful revival. An obsolete host may unlink the shared socket path only while that path still names its own active listener; it must never remove a replacement host's socket during overlapping same-config startup or shutdown. Each host keeps a private listener path, and a reconnecting server may restore a missing public link only when exactly one matching private listener is live; multiple matches fail visibly instead of selecting one arbitrarily. Set `FARMING_NATIVE_PTY_HOST_PERSIST=0` only when the host should die after every Server process loss. Avoid adding alternate terminal-runtime paths when improving product behavior.

Agent processes must not blindly inherit the Farming server process environment. The backend resolves a user shell environment for interactive agents, overlays only agent-relevant server variables such as model credentials, proxies, SSH auth, and certificate paths, then normalizes terminal variables (`TERM`, `COLORTERM`, `TERM_PROGRAM`) and strips server/runtime shims such as `NO_COLOR`, non-interactive `cat` pagers, dynamic-library overrides, and Node heap flags. Keep new launch paths on this resolver instead of copying `process.env` directly.

On macOS, Codex executable discovery checks `FARMING_CODEX_BIN`, the bundled CLI paths under both `Codex.app` and `ChatGPT.app`, and then the resolved user shell `PATH`. Session resume must select a CLI compatible with the session's recorded version or fail visibly.

Shell agents (`bash` / `zsh`) preserve the user's normal interactive startup and prompt by default, like VS Code's integrated terminal. Farming observes those shells through its invisible OSC busy / cwd markers rather than owning `PS1` or `PROMPT`. Use `FARMING_SHELL_CONTROLLED_PROMPT=1` for the compact controlled prompt, or `FARMING_ANONYMIZE_SHELL_PROMPT=1` for privacy-sensitive screenshots. Keep these shell-only variables out of directly launched coding agents.

On macOS, the built-in bash and zsh entries follow VS Code's built-in profiles and start as login shells. Resolve shell environment per target shell, and never pass inherited `PS1`, `PROMPT`, or prompt hooks between bash and zsh; the launched shell's own startup files are the sole owner of its presentation.

The product CLI defaults to:

- port `6694`;
- base path `/farming`;
- config directory `~/.farming`;
- token auth enabled.

The startup token is stored in `~/.farming/.session-token` and must be reused across restarts and upgrades unless `FARMING_TOKEN` explicitly overrides it. New token generation uses locale `auto`: Chinese time zones produce Chinese haiku-style tokens, Japanese time zones produce Japanese haiku-style tokens, and other time zones produce English passphrases.

Update behavior is installation-aware. An npm installation uses its package root as a stable bootstrap identity and publishes complete versions as immutable Package Images beside an atomic installation-wide current selection. Every running Config stays pinned to the exact Image that started it. An in-app update prepares and verifies the target while the old Server remains live, atomically changes the selection, and restarts only the initiating Config; other Configs continue on their old Images until they restart or update themselves. Selection changes use compare-and-swap, rollback restarts the initiating Config from its exact prior Image, and cleanup retains the current, previous, recent, and exactly live Images. A later explicit npm replacement of the bootstrap package becomes the selection for new launches without rewriting live Images. On startup, reconcile a persisted `restarting` state against the authoritative running version: reaching or superseding the target succeeds, while an unmatched restart fails after a bounded interval so the update can be retried. Source checkouts update through Git; standalone CLI and standard app-bundle artifacts update manually, without a configurable Server-side update source. The separate `linux-x64-legacy-glibc228` tarball is a first-install bootstrap: it activates its pinned glibc 2.28 runtime only when needed, installs the bundled application under the private `~/.farming/npm` prefix, and writes a stable compatibility launcher. Subsequent application updates use the normal npm updater and the same prefix; only compatibility-runtime changes require another bootstrap package.

## Development Commands

```bash
npm install
npm run build
npm test
npm run typecheck
npm run lint
npm run check
```

Standalone Farming Net development:

```bash
FARMING_NET_PORT=6693 FARMING_NET_BASE_PATH=/farming-net npm run start:net
```

`npm test` uses four isolated worker processes by default. Set `FARMING_TEST_CONCURRENCY=1` for serial debugging, or choose a value from 1 to 16 when tuning CI capacity.

Local source smoke for the product path:

```bash
PORT=6695 FARMING_PORT=6695 FARMING_BASE_PATH=/farming FARMING_DISABLE_AUTH=1 npm start
```

Use another port when `6694` is already occupied. When serving the source build under `/farming`, the Vite build and the backend server must use the same `FARMING_BASE_PATH=/farming`. If you split the steps, run `FARMING_BASE_PATH=/farming npm run build` before `FARMING_BASE_PATH=/farming node bin/farming start`; otherwise `dist/index.html` points at `/assets/...` and the browser page white-screens because JS/CSS assets 404. Direct `backend/server.cjs` startup is reserved for test harnesses.

Playwright UI tests:

```bash
npm run test:e2e:playwright
npm run test:e2e:playwright:update
```

Product screenshot refresh:

```bash
npm run docs:product:screenshots
```

Packaging:

```bash
npm run release:cli
npm run release:cli:all
npm run release:app
npm run release:app:linux-compat  # explicit glibc 2.17 builder only
npm run release:app:legacy-linux  # Linux x64 legacy glibc 2.28 runtime bundle
```

The Linux `glibc217` ABI bundle is separate from the normal release workflow. Build it only inside a clean Linux x64 environment whose glibc is exactly 2.17 and which provides Node.js 22+, GCC/G++, Make, and Python 3. Its `node-pty` module is compiled from source and ABI-checked before packaging. The regular GitHub Release workflow additionally publishes `linux-x64-legacy-glibc228`: it embeds a pinned glibc 2.28 runtime, bootstraps a private npm-managed installation, and must smoke-test server startup plus a real native PTY agent through the compatibility launcher.

Pre-release gate for public versions:

- Treat a fully successful `CI` workflow for the exact release commit as the first non-negotiable publication gate. Do not dispatch or continue a release while any CI job is missing, pending, cancelled, or failed; fix the product or test failure, push a new candidate revision, and restart qualification from that revision.
- Start from a clean worktree. Bump `package.json` and `package-lock.json` before dispatching a release; never move or reuse an existing `vX.Y.Z` tag.
- Run the fast source checks first: `npm test`, `npm run typecheck`, `npm run lint`, `npm audit --omit=dev`, and `FARMING_BASE_PATH=/farming npm run build`.
- Run focused Playwright specs for changed UI surfaces. Prefer small, targeted browser checks during iteration, then broaden only when the changed surface warrants it.
- Run `npm run test:pre-release:codex-ui` once for every release candidate after the focused deterministic browser checks. This real Codex, cross-skin composite case is a release blocker; record its revision-bound result and artifacts. See `docs/products/code/real-codex-release-case.md`.
- Run `npm run test:pre-release:terminal-input` once for every release candidate. This deterministic loopback gate switches an existing Agent, types and deletes through xterm, rejects a focus-triggered full `state` payload, requires the focused preview to stay compact, and enforces a key-to-PTY-output p95 of at most 250 ms. Preserve the revision-bound result and trace on failure; remote dogfood remains a separate human-like smoke rather than a substituted network benchmark.
- Add or update `release-notes/vX.Y.Z.md` for the release. The package version, Git tag, and release note filename must match exactly, and the GitHub Release body should come from that file rather than a generic inline note.
- Treat the GitHub Wiki as a release output. Before dispatching, compare the release notes with the Wiki `Home` and `English` pages. If user-visible positioning, installation or upgrade steps, supported Agents, architecture, major workflows, or screenshots changed, prepare updates for both Wiki languages and verify every linked page and image resolves. Before any Wiki push, an independent Agent must review the draft against the release notes, current product behavior, bilingual parity, public-data safety, and live links/assets; revise the draft until no blocking or important findings remain. Publish the approved Wiki only after the versioned GitHub Release URL exists. If no Wiki content changed, have the independent reviewer validate that decision and record `Wiki: no change required` in the release evidence. Do not call the release complete until the reviewed Wiki update or reviewed no-change decision has been verified.
- Before pushing to GitHub, scan the full outgoing diff for secrets, private hosts, tokens, personal machine paths, company-internal environment names, and internal vendor/tool names. Public release notes and docs must not mention private deployment hosts or local security tooling names; keep those details in local-only ignored files or private handoff notes.
- Do a human-like smoke on the local Mac browser: create and switch Codex / Claude / shell agents, type through the terminal and composer, verify Chinese IME, select/copy terminal text, click file/path links, pin/unpin, archive, refresh/reconnect, and watch obvious CPU/memory behavior.
- For macOS release artifacts, explicitly record whether the binary is ad-hoc signed, Developer ID signed, or notarized. If it is not notarized, verify and document the first-run security allow behavior instead of treating a manually allowed smoke as a clean first-run experience.
- Do a human-like smoke on the configured remote Linux dogfood environment with token auth: agent creation, terminal input/output, refresh/reconnect, archive cleanup, native pty host recovery, and process-count cleanup.
- Verify the remote Linux instance has only the intended Farming service/listener and no leaked old Farming server, native pty host, bash, zsh, Codex, or Claude processes from previous deploys.
- Before downloading a container image or bootstrapping a new toolchain, inventory existing release artifacts, local caches, and configured Linux builders. Prefer an existing clean physical or remote x86_64 Linux environment and its already-provisioned toolchain or cached builder container for Linux packaging and smoke tests; do not assume the host's default compiler is the intended builder. ARM-hosted x86 emulation is a fallback only when no suitable real Linux builder is available.
- Build release artifacts through the repo release scripts or GitHub release workflow, not by committing generated bundles.
- Guard packaged dependencies: when packaging-related files change, compare package contents or manifests against the previous release so an update cannot accidentally drop required production dependencies, native assets, runtime files, or install scripts.
- Smoke-test the built CLI/app bundle artifacts, not only the source checkout.
- Push the release commit and require the `CI` workflow for that exact revision to complete successfully before publishing. A green Release workflow is not a substitute for failed CI. The Release workflow must wait for and fail closed on that revision-bound CI result.
- Push the release commit, then manually dispatch `.github/workflows/release.yml` from that branch with the exact unprefixed `release_version` (`X.Y.Z`). The workflow runs all builds and smokes before npm publish. Only after npm has accepted the package and proved the matching source revision does it create the annotated `vX.Y.Z` tag and a draft GitHub Release, then make that draft public. Thus an npm failure creates no official tag or Release and the version remains reusable. If npm succeeds but GitHub Release publication fails, rerun the same dispatch to finish it; that version is valid and must not be reused. Watch the workflow and confirm Linux/macOS artifacts, checksums, manifest, npm package, and the public GitHub Release page using `release-notes/vX.Y.Z.md` exist before calling the release done.
- The release workflow publishes `farming-code@X.Y.Z` to npm. Bootstrap the first public package with a scoped automation `NPM_TOKEN` repository secret; after that first package exists, configure npm Trusted Publishing for this repository and `.github/workflows/release.yml`, remove the token secret, and let GitHub OIDC publish with provenance. Never reuse an npm version or a Git tag whose matching npm package has been published.

## Testing Expectations

- `npm run typecheck` is one release gate for all typed surfaces: the React frontend, strict backend and Browser Resource TypeScript configured by `tsconfig.backend-runtime.json`, the remaining checked JavaScript backend configured by `tsconfig.backend.json`, independently checked classic browser TypeScript, shared protocol TypeScript, build-script TypeScript, structurally checked backend tests configured by `tsconfig.tests.json`, strictly checked frontend unit tests configured by `tsconfig.unit-tests.json`, and the usage scanner. Backend and Browser Resource runtime sources use `.cts`, keep domain types with the implementation, delete superseded `.js`, and load only generated `.cjs`. `npm run build:backend-runtime` generates those ignored CommonJS files. Classic browser and shared protocol sources use `.ts`; `npm run build:classic-runtime` generates their original `.js` compatibility paths without bundling away UMD/global behavior. Backend tests use `.ts` and must stay inside the test typecheck gate even when their dynamic fixtures do not use the production runtime's strict settings. Packages carry runtime JavaScript, not executable TypeScript. Do not silence a file with `@ts-nocheck` or replace a domain type with `any` merely to make the gate green.
- Backend tests live in `backend/tests/`.
- Browser and visual flows live in `tests/e2e/`.
- Use fake coding agents for deterministic CI-style checks.
- Real Codex / Claude smoke tests must be explicit, low-volume, and isolated.
- The real Codex cross-skin release gate lives at `tests/e2e/internal/real-codex-release-case.spec.ts`; keep it out of the default fake-Agent suite and keep its ordered state chain singular.
- Derive feature tests from the state-transition model, not only from happy-path outputs. Cover legal transitions, risky illegal sequences, safety invariants, and bounded progress or recovery from pending states, including concurrency, reordering, retries, cancellation, disconnects, and restarts where relevant.
- Treat tests, logs, code inspection, and browser observations as revision-bound evidence for stated safety and liveness obligations; a green test suite alone is not a complete correctness proof.
- Critical desktop and mobile visual states should be covered by Playwright screenshots where practical.
- Main Projects page membership for Codex / Claude history sessions is covered by `backend/tests/test-code-main-page-session.ts`; update it when changing `mainPageSessionKeys` behavior.

## Files And Editor

Project Files are scoped to a persisted Project workspace. Their authoritative browser identity is derived only from that workspace and must not change when Agents hydrate, reorder, or disappear. A live Agent id may provide temporary access authorization and an optional `sourceAgentId` return association, but it is never the file key; an empty Project must continue through the validated Project workspace identity. Main Agent rows should not show Files. The file service must keep all operations inside the workspace root and support:

- lazy directory tree loading;
- text read and save with version checks;
- create / rename / delete / move;
- file search through ripgrep where available;
- git status / diff / blame;
- bounded file watching when enabled.

The frontend should keep the Files section in the project scroll flow rather than adding a second nested scrollbar. The editor is a lightweight intervention surface, not a full IDE replacement.

## Main Agent

The Main Agent is a long-term product mechanism, not just another chat. It should help observe running agents, summarize progress, identify blocked or stale work, and coordinate child agents when useful. It should not spawn child agents just because it can.

The Main Agent control CLI and skill files are generated by backend code. The canonical public development instructions remain this `AGENTS.md`.

## Release And Open Source Hygiene

- Do not commit release binaries.
- Do not commit internal hosts, private paths, personal machine names, or private documentation links.
- Do not commit secrets or authentication tokens.
- Keep config examples generic.
- Product screenshots must use anonymous demo workspaces and example hostnames.
