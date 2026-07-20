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

For public documentation, the default Markdown file should be English. Keep the Simplified Chinese version beside it with the `.zh_cn.md` suffix, for example:

- `README.md`
- `README.zh_cn.md`
- `docs/products/code/mobile-guide.md`
- `docs/products/code/mobile-guide.zh_cn.md`

Each English document should link to its Chinese version near the top. Each Chinese document should link back to the English version.

Do not maintain public conversation logs. Ordinary Q&A, temporary debugging, and transient implementation notes should not be written to public docs. Important product, architecture, or interaction decisions should go into the appropriate durable document.

## Engineering Principles

- Keep changes scoped to the request.
- Prefer existing patterns and local helpers.
- Avoid premature abstraction in prototype surfaces.
- Validate user input and return actionable errors.
- Do not hard-code secrets or private environment assumptions.
- Codex transcript/chat rendering must pass user-visible text through the shared backend sanitizer for Codex internal envelopes; when Codex changes injected context formats, update that sanitizer and its tests in the same change.
- Keep agent processes isolated.
- Use asynchronous IO for server paths.
- Cache heavy filesystem / CLI scans with stale-while-refresh behavior where the codebase already does so.
- For every non-trivial feature, derive a minimal state-transition model from the known business requirements before implementation. Identify the authoritative state owner and define each transition's trigger, guard, effect, failure result, and retry / cancellation / concurrency / recovery semantics.
- Treat correctness as both safety and liveness. Safety means unintended bad states are unreachable and every transition preserves the required invariants. Liveness means that, under explicitly stated external assumptions, every transient state has a bounded success, failure, cancellation, timeout, or recovery path and the intended good state is eventually reachable.
- Simplify state machines before adding abstraction: merge behaviorally equivalent states, remove business-meaningless intermediate states, keep one source of truth, and reject illegal transitions at the boundary. After correctness is established, evaluate whether the design is easy to prove, cohesive, loosely coupled, hard to misuse through its API, and clear to operate through the UI.
- Continuous test capacity is finite. Do not add a fallback product path unless it can be exercised continuously with the same acceptance bar as the primary path. An untested fallback is unsupported behavior, not resilience; prefer one explicit path with a visible bounded failure. Recovery and retry may stay inside that supported implementation, but must not select a second implementation. Diagnostic alternatives must be manually selected and remain outside the product support contract. If an alternate path becomes necessary, either make it the primary path or fund equivalent continuous coverage before shipping it.
- Add or update tests in proportion to risk.
- Preserve visual style when fixing behavior unless the user explicitly asks for a visual change.
- Do not add, remove, or rewrite visible product copy without a clear product reason.

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

Terminal display recovery is a checkpointed state-machine protocol. The native PTY host's headless xterm instance is the authoritative reducer. Each PTY runtime has a unique epoch; output transitions advance both `outputSeq` and `stateRevision`, while clear and resize advance only `stateRevision`. A serialized checkpoint must carry the exact epoch, sequences, screen, and dimensions committed by that reducer. WebSocket coalescing must preserve individual transition indexes. The browser validates every index in a coalesced message, but submits each contiguous output / clear run to xterm as one write batch. Resize remains an ordered batch boundary; after committing it, the browser holds its following redraw until short bounded output quiescence, then paints the burst once so a full-screen TUI redraw is not exposed chunk by chunk. A browser may apply only the next contiguous transition for its current epoch; duplicates are ignored, while gaps, epoch changes, hidden-page suspension, and reconnects require an authoritative `/session-view` checkpoint before live reduction continues. Do not poll `/session-view`; retry transport failures with backoff, and stop visibly when repeated responses violate the same checkpoint invariant. Never paint a checkpoint known to be behind the current replay target, and suppress incremental xterm painting while installing a full checkpoint so recovery appears as one latest screen rather than historical playback. On PTY exit, wait for a 250 ms trailing-data quiescence window, drain the reducer, and preserve an exact final checkpoint. A missing or non-exact final checkpoint is a visible fatal state-proof failure, never a raw-output fallback presented as an authoritative screen.

Terminal input remains a direct raw PTY stream: do not add per-input ACK, deduplication, automatic replay, or timing-based textarea fallbacks around xterm `onData`. Multiple Code / CRT viewers share one authoritative display and may all write; the AgentManager input queue serializes accepted input in server arrival order. There is no browser controller lease, takeover UI, renderer ACK protocol, or viewer-count UI. An ambiguous transport failure never automatically replays input. Geometry means only display dimensions (`cols` and `rows`). All browser-layout-driven geometry changes are trailing-coalesced as one complete `cols + rows` update so a sustained window drag cannot repeatedly reflow xterm and retrigger a full-screen TUI redraw. Do not branch this behavior on renderer buffer type or output length; TUI alternate-screen state makes that classification unreliable. Explicit attach, recovery, and forced fits remain immediate. The backend keeps at most one in-flight resize plus the latest pending size. Reducer backlog alone drives PTY high/low-watermark flow control, and a slow browser is isolated by WebSocket backpressure instead of pausing the shared PTY. The native PTY host's controller generation remains an internal server-process handoff boundary: it closes old admissions, drains every already-admitted mutation, and only then publishes the new server generation. It is not browser ownership.

Browser-facing Agent state has four explicit domain boundaries. `runtimeBinding` is the tagged runtime contract (`terminal`, `acp`, or `json`); legacy flat runtime fields remain an internal persistence compatibility shape and must not leak back into clients or new feature code. Persisted experimental Codex `app-server` bindings migrate to ACP at this boundary and must never restart an App Server process. `runtimeObservation` is the backend-owned current-runtime classification consumed by UI and restart/deploy guards; frontends must not re-infer it from terminal text. Provider-specific executable, session planning, runtime support, home environment, and normalized capabilities belong in `ProviderAdapter`, so generic lifecycle/UI code reads capabilities instead of provider-name lists. Project Files HTTP APIs use `WorkspaceRoot.rootId`; the old `agentId` form is a read compatibility adapter only. Code and CRT WebSockets negotiate and validate the shared versioned browser protocol before processing messages. Terminal input remains exempt from command ACK/replay semantics.

Routine per-Agent terminal metadata changes use the protocol's whitelisted `agent-update` patch rather than broadcasting the full workspace state. This patch channel is closed to arbitrary Agent fields and may carry only terminal input, shell status, terminal status, and runtime-observation metadata. Reconnect and initial hydration still use the authoritative full state.

Both browser skins default to xterm.js, and WebGL is the single supported product renderer. WebGL activation failure or unrecoverable context loss must stop visibly; do not silently switch a live terminal to the DOM renderer. The Ghostty web renderer remains available only as an explicit debug path via `localStorage.farmingTerminalEngine = 'ghostty'` and is not a product fallback.

Packaged native-addon extraction must compare existing bytes and use atomic replacement. Node-pty calls its native loader more than once; truncating an already mmap'd Linux `.node` file causes the first `pty.fork` to segfault even though the extracted checksum is correct.

For Codex, Claude Code, OpenCode, and Qoder, Farming Code's structured Chat runtime uses ACP. Codex uses `@agentclientprotocol/codex-acp` as its only structured Chat path; Codex-specific behavior belongs at the provider-adapter boundary, not in a second lifecycle or UI implementation. The Chat / Terminal control restarts the Agent into ACP or the native PTY runtime and resumes the same provider session; it is not a view-only toggle. A newly opened Terminal that has not received user input may switch directly into a fresh ACP Chat before the provider has materialized its history record. Once Terminal input has occurred, keep the resumable-session guard so a missing history record can never silently discard a conversation. Standard ACP `additionalDirectories` and `mcpServers` belong to the session-start boundary, survive runtime replacement and recovery, and must stay out of browser-facing Agent state; any persisted copy belongs only in the private session record. Outbound media must be sent natively only when the live Agent advertises that prompt capability, with an explicit readable fallback otherwise. Legacy JSON CLI Chat remains a compatibility reader.

Live Codex Terminal model changes must follow the CLI's rendered `/model` and reasoning menus and confirm the resulting footer before releasing later Composer input. Do not automate the TUI with fixed delays or assume catalog indexes match the visible menu. `/fast on|off` is a non-interactive command: once its complete input is accepted by the PTY, release later Terminal input while confirmation continues outside the input queue. Fast / Ultra controls remain visible but disabled when the active runtime catalog does not advertise them.

ACP history replay and live updates must reduce into the same ordered entry stream. Do not introduce a backend `Turn -> Item` reconstruction for ACP. User-facing result/process grouping is an ACP frontend attention projection: it must remain reversible, preserve entry order and tool details, and hide Codex internal heartbeat/context activity without deleting visible automation notifications.

ACP recovery may skip full `session/load` only from an exact, atomically committed Farming reducer checkpoint whose provider, Agent Home, session, workspace, and provider freshness still match. Fence the checkpoint dirty before a prompt; missing, dirty, stale, corrupt, or unverifiable state must visibly remain on the bounded load/repair path. Transcript pages carry compact ordered tool envelopes, while exact raw tool detail remains backend-owned and lazy-loaded by tool-call id.

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
│   ├── server.js
│   ├── agent-manager.js
│   ├── native-session-engine.js
│   ├── native-pty-host.js
│   ├── native-pty-host-client.js
│   ├── local-session-engine.js
│   ├── farming-session-store.js
│   ├── run-history-store.js
│   ├── shell-busy-integration.js
│   ├── workspace-file-service.js
│   ├── workspace-file-router.js
│   ├── farming-app-cli.js
│   ├── farming-net-server.js
│   ├── farming-net-registry.js
│   ├── farming-net-pass.js
│   ├── storage-layout.js
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
│   ├── *.js                # Shared browser terminal/session bridges
│   └── vendor/
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

## Runtime Configuration

Farming stores runtime settings under `~/.farming/settings.json` by default. Backend-owned file locations under the config directory are centralized in `backend/storage-layout.js`; new config-dir files should go through that helper instead of hand-writing `path.join(configDir, ...)` in feature modules. Important user-facing settings include:

- `defaultLaunchAgent`
- `agentLaunchProfiles.codex`
- `agentLaunchProfiles.claude`
- `agentHomes` (home metadata for Codex, Claude, OpenCode, and Qoder; each provider keeps a non-removable `default` home)
- `searchTimeoutMs` (shared timeout for Project Files search and Agent history search; defaults to 15 seconds)
- `workspaceHistory`
- `projectWorkspaces` (the persisted Projects membership; Agent, file, restored Project session, and Git-worktree entry points all add the same workspace identity, while only Remove Project deletes it)
- `pinnedProjectWorkspaces` (the ordered pinned-Project queue; pinned Projects render before ordinary Projects, a newly pinned Project appends after existing pins, and unpinning restores the ordinary Project order)
- `dangerouslySkipAgentPermissionsByDefault` (launch supported coding agents such as Codex, Claude, OpenCode, Qoder, Qwen, Aider, GitHub Copilot CLI, and Amazon Q with their provider-specific dangerous permission-skip flags by default)
- `crtSkinEffectsEnabled` (controls only the CRT skin's scanlines, mask, vignette, and infrequent scan beam; Farming Code must not read or apply it)
- `crtDynamicHeatEnabled` (disabled by default; lets the CRT skin apply activity-level classes for dynamic Agent colors and sizing)
- `crtTerminalFontSize` (the CRT opened-terminal text size in pixels, clamped to `10`–`20`; the default is `15`)

Farming Net uses `~/.farming-net` by default and must remain isolated from the main Farming runtime. Its `.session-token`, signing key pair, `instances.json`, and `farming-net-server.json` are private runtime files. The browser-facing registry accepts only HTTP(S) endpoints and removes credentials, query strings, and fragments; target tokens must never be exposed through the registry API. Federated passes use Ed25519, an exact instance-id audience, a maximum 60-second lifetime, and replay rejection. Targets opt in through `~/.farming/farming-net-trust.json`, exchange a valid pass for their own HttpOnly cookie, and immediately redirect to a clean URL. Use the `FARMING_NET_*` environment variables for the portal's port, host, base path, config directory, token, pass TTL, and explicit local-only auth disable switch.

Runtime session metadata lives under `~/.farming/sessions/`, not in `settings.json`. Farming assigns each persisted Agent record a stable `fsess_*` id used as the session metadata filename. The live native pty `agent-...` id is stored as runtime metadata, while Codex / Claude provider session ids are stored as external correlation fields. `sessions/index.json` owns the main Projects page provider-session membership; `settings.mainPageSessionKeys` remains only an API compatibility projection. Codex `tmp_uuid...` live ids must not enter this persisted main-page membership; provider sessions not listed there stay in History.

Run/archive history lives in `history/runs.json`, not in `settings.json`. A run may keep an optional `customTitle` so an explicitly renamed Agent retains that display name when restored; older entries without it remain valid. Theme overrides live in `theme-settings.json` under the same config directory. Server control metadata (`farming-server.json`, `farming-server.pid`, `farming-server.log`), the startup token (`.session-token`), and native pty host logs also belong to the config directory layout. External provider histories such as Codex `~/.codex/sessions` and Claude history files are read-only integrations and should not be treated as Farming-owned metadata.

Interactive runtime sessions default to the native pty host. The host uses a Farming-specific local socket derived from `configDir`, keeps PTY processes outside the Farming server process, and exposes recovery metadata to the server after restarts. By default, same-revision server shutdown preserves the host for restart recovery; after the last live session and client disappear, the host shuts itself down after a short idle grace period. The server and host exchange a runtime code fingerprint when connecting. An application upgrade or fingerprint mismatch performs a transactional controlled rotation: block new mutations, drain and freeze the exact reducer cut, serialize every still-live Terminal, require a matching preparation token to stop the old host, and revive the serialized screen in a new PTY epoch. Serialization failure must resume the old host and abort rotation. An unexpected host crash is process loss and must never be presented as successful revival. Set `FARMING_NATIVE_PTY_HOST_PERSIST=0` only when the host should die with every server shutdown. Avoid adding alternate terminal-runtime paths when improving product behavior.

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

Update behavior is installation-aware. npm installations query the `farming-code` registry metadata and may update in one click: install the target package while the current server is alive, restart only after installation succeeds, persist progress under the config directory, and attempt a rollback if restart fails. Source checkouts update through Git and standalone CLI artifacts update manually. Standard app-bundle installs may use a trusted HTTP(S) directory or manifest URL stored as `settings.updateUrl`; every bundle must match the runtime and provide a 64-character `sha256`. The separate `linux-x64-legacy-glibc228` tarball is a first-install bootstrap: it activates its pinned glibc 2.28 runtime only when needed, installs the bundled application under the private `~/.farming/npm` prefix, and writes a stable compatibility launcher. Subsequent application updates use the normal npm updater and the same prefix; only compatibility-runtime changes require another bootstrap package.

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

Use another port when `6694` is already occupied. When serving the source build under `/farming`, the Vite build and the backend server must use the same `FARMING_BASE_PATH=/farming`. If you split the steps, run `FARMING_BASE_PATH=/farming npm run build` before `FARMING_BASE_PATH=/farming node backend/server.js`; otherwise `dist/index.html` points at `/assets/...` and the browser page white-screens because JS/CSS assets 404.

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

- Start from a clean worktree. Bump `package.json` and `package-lock.json` before creating a new release tag; never move or reuse an existing `vX.Y.Z` tag.
- Run the fast source checks first: `npm test`, `npm run typecheck`, `npm run lint`, and `FARMING_BASE_PATH=/farming npm run build`.
- Run focused Playwright specs for changed UI surfaces. Prefer small, targeted browser checks during iteration, then broaden only when the changed surface warrants it.
- Run `npm run test:pre-release:codex-ui` once for every release candidate after the focused deterministic browser checks. This real Codex, cross-skin composite case is a release blocker; record its revision-bound result and artifacts. See `docs/products/code/real-codex-release-case.md`.
- Run `npm run test:pre-release:terminal-input` once for every release candidate. This deterministic loopback gate switches an existing Agent, types and deletes through xterm, rejects a focus-triggered full `state` payload, requires the focused preview to stay compact, and enforces a key-to-PTY-output p95 of at most 250 ms. Preserve the revision-bound result and trace on failure; remote dogfood remains a separate human-like smoke rather than a substituted network benchmark.
- Add or update `release-notes/vX.Y.Z.md` for the release. The package version, Git tag, and release note filename must match exactly, and the GitHub Release body should come from that file rather than a generic inline note.
- Before pushing to GitHub, scan the full outgoing diff for secrets, private hosts, tokens, personal machine paths, company-internal environment names, and internal vendor/tool names. Public release notes and docs must not mention private deployment hosts or local security tooling names; keep those details in local-only ignored files or private handoff notes.
- Do a human-like smoke on the local Mac browser: create and switch Codex / Claude / shell agents, type through the terminal and composer, verify Chinese IME, select/copy terminal text, click file/path links, pin/unpin, archive, refresh/reconnect, and watch obvious CPU/memory behavior.
- For macOS release artifacts, explicitly record whether the binary is ad-hoc signed, Developer ID signed, or notarized. If it is not notarized, verify and document the first-run security allow behavior instead of treating a manually allowed smoke as a clean first-run experience.
- Do a human-like smoke on the configured remote Linux dogfood environment with token auth: agent creation, terminal input/output, refresh/reconnect, archive cleanup, native pty host recovery, and process-count cleanup.
- Verify the remote Linux instance has only the intended Farming service/listener and no leaked old Farming server, native pty host, bash, zsh, Codex, or Claude processes from previous deploys.
- Before downloading a container image or bootstrapping a new toolchain, inventory existing release artifacts, local caches, and configured Linux builders. Prefer an existing clean physical or remote x86_64 Linux environment and its already-provisioned toolchain or cached builder container for Linux packaging and smoke tests; do not assume the host's default compiler is the intended builder. ARM-hosted x86 emulation is a fallback only when no suitable real Linux builder is available.
- Build release artifacts through the repo release scripts or GitHub release workflow, not by committing generated bundles.
- Guard packaged dependencies: when packaging-related files change, compare package contents or manifests against the previous release so an update cannot accidentally drop required production dependencies, native assets, runtime files, or install scripts.
- Smoke-test the built CLI/app bundle artifacts, not only the source checkout.
- Push the release commit first, then push the new `vX.Y.Z` tag. Watch the GitHub Release workflow and confirm Linux/macOS artifacts, checksums, manifest, and the GitHub Release page using `release-notes/vX.Y.Z.md` exist before calling the release done.
- The release workflow also publishes `farming-code@X.Y.Z` to npm. Bootstrap the first public package with a scoped automation `NPM_TOKEN` repository secret; after that first package exists, configure npm Trusted Publishing for this repository and `.github/workflows/release.yml`, remove the token secret, and let GitHub OIDC publish with provenance. Never reuse an npm version or an existing Git tag.

## Testing Expectations

- Backend tests live in `backend/tests/`.
- Browser and visual flows live in `tests/e2e/`.
- Use fake coding agents for deterministic CI-style checks.
- Real Codex / Claude smoke tests must be explicit, low-volume, and isolated.
- The real Codex cross-skin release gate lives at `tests/e2e/internal/real-codex-release-case.spec.ts`; keep it out of the default fake-Agent suite and keep its ordered state chain singular.
- Derive feature tests from the state-transition model, not only from happy-path outputs. Cover legal transitions, risky illegal sequences, safety invariants, and bounded progress or recovery from pending states, including concurrency, reordering, retries, cancellation, disconnects, and restarts where relevant.
- Treat tests, logs, code inspection, and browser observations as revision-bound evidence for stated safety and liveness obligations; a green test suite alone is not a complete correctness proof.
- Critical desktop and mobile visual states should be covered by Playwright screenshots where practical.
- Main Projects page membership for Codex / Claude history sessions is covered by `backend/tests/test-code-main-page-session.js`; update it when changing `mainPageSessionKeys` behavior.

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
