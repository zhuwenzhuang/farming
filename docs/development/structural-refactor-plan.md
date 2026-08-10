# Structural Refactor Strategy

> Chinese version: [structural-refactor-plan.zh_cn.md](./structural-refactor-plan.zh_cn.md)

This document defines how Farming reduces structural debt while product work
continues on `main`. It owns the target boundaries, dependency order,
coordination rules, and completion criteria. It is not a progress log or a
file-by-file implementation inventory. Current assignments, base SHAs, and
temporary branch status belong in the active issue or coordination board.

## Outcome

The objective is not shorter files. The objective is a smaller change blast
radius:

- every authoritative state has one named owner;
- product views render state instead of reconstructing backend truth;
- runtime and provider differences stay behind typed boundaries;
- risky state transitions can be tested without starting the whole product;
- feature and refactor work can land independently in small verified changes.

A refactor that only moves code, introduces a large host interface, duplicates
a production path, or replaces one large file with several mutually coupled
files has not achieved this objective.

A behavior-neutral physical split can still be valuable when it preserves
production code volume and control flow, introduces no new mutable state or
cross-module API, and follows an already visible component, pure-function, or
rendered-surface boundary. Its benefit is lower review, merge-conflict, and
Coding Agent context cost. Such a split claims physical ownership only; it
must not be presented as a completed state-architecture refactor.

A shorter host file, focused green tests, or a more explicit state machine is
not sufficient evidence by itself. Review must also show lower total system
knowledge, fewer state identities, and lower cross-module reasoning cost.
Domains with confirmed complexity regressions converge before new large
extractions begin.

## Invariants

Every refactor slice must preserve the following:

- **Behavior.** HTTP routes, WebSocket protocol shapes, UI interactions,
  visual style, product wording, persistence, recovery, and cleanup semantics
  remain unchanged unless a separately approved product change owns them.
- **One product path.** New and old implementations do not remain as parallel
  production paths. A slice establishes a boundary, switches the caller, and
  removes the superseded path within a bounded sequence.
- **One state owner.** Extracted code either owns a coherent state machine or
  is a pure policy. It must not mirror mutable state owned elsewhere.
- **State and transition rules stay in one domain.** Registries and stores may
  retain authoritative identity and data, but they do not interpret the same
  operation outcome alongside a domain service.
- **Complexity has a budget.** Review compares removed host responsibility,
  added production code, ports and APIs, state maps and generations, and
  test-only exports. A small host reduction with a large system-wide increase
  is rejected unless it closes a concrete safety gap with no smaller model.
- **Exact identity.** Agent, runtime epoch, Config instance, workspace,
  provider home, and external-resource ownership remain exact across every
  boundary.
- **Bounded outcomes.** Cancellation, timeout, uncertain mutation outcomes,
  restart, reconnect, and stale completion retain explicit terminal paths.
- **Current gates.** Each mergeable slice passes the smallest focused checks
  while iterating and every repository gate justified by its risk before merge.

Canonical subsystem contracts remain in their owning documents, including the
[ACP runtime](../products/code/acp-runtime.md),
[Terminal state protocol](../products/code/terminal-state-protocol.md), and
[Agent list state protocol](../products/code/agent-list-state-protocol.md).

## Target Boundaries

```text
Browser views
  React layout and rendering
          |
          v
Application controllers and pure reducers
  Session inventory / Projects / Settings / Chat / Terminal attachment
          |
          v
Typed HTTP and WebSocket clients
          |
          v
Server bootstrap
  auth / middleware / static mounting / router and WS registration
          |
          v
Application services
  Agent lifecycle / Composer / Fork / Worktree / projections
          |
          v
Runtime ports and provider policies
  native PTY host / ACP host / provider adapters
```

The dependency direction points downward. A lower layer must not import a UI
controller or a higher-level application service. Compatibility shapes stay at
HTTP, WebSocket, persistence, and runtime-host boundaries.

### Backend ownership

- `AgentManager` remains the public facade and authoritative Agent registry
  while extraction is in progress. It owns exact Agent identity and top-level
  lifecycle admission, then delegates coherent domain work through narrow
  ports.
- A domain service owns its internal state and postconditions. It must not
  receive the complete Manager merely to call arbitrary methods.
- A stateful extraction moves the authoritative state cluster together with
  every transition, recovery, disposal, and exact cleanup rule that interprets
  it. Moving methods while their mutable maps remain in the host is a physical
  split, not state ownership.
- Callback ports carry facts or invoke narrow effects; they do not hide the
  host's decision tree inside constructor closures. Review semantic knowledge,
  not a fixed callback-count or line-count threshold: a closure that still
  decides identity, ordering, retry, or outcome keeps that responsibility in
  the host.
- Fork is owned by a coordinator with explicit inputs, effects, rollback, and
  uncertain outcomes over narrow Worktree, lifecycle-persistence, and ACP
  runtime ports. Remaining Manager domains follow the same port discipline.
- Per-Agent lifecycle exclusion is owned by one coordinator. It owns operation
  tokens, replacement-Agent adoption, same-key joining, conflicting-operation
  ordering, shutdown admission, and drain visibility; the Manager supplies the
  lifecycle effect but does not expose or mutate the coordinator's map.
- Agent-start admission is a separate owner for create-request idempotency,
  in-flight workspace association, shutdown drain visibility, and exact token
  release. Project deletion queries it through workspace-scoped pending
  operations rather than inspecting an admission map.
- Project mutation admission owns request-key idempotency and workspace-key
  exclusion, including queued deletes and shutdown drain visibility. Agent
  startup asks only whether its workspace intersects an admitted deletion.
- Runtime stop proof and temporary exit-event suppression share one tracker.
  Verified exit, restart cleanup, event filtering, exact forget, and disposal
  therefore cannot diverge across independent Manager-owned sets.
- Provider-session mutation ordering is provider-neutral and keyed by provider,
  home, and exact session identity. Codex archive behavior remains an adapter
  effect; queueing, same-operation joining, failure release, and drain are not
  Codex-specific state machines.
- Terminal-provider control ordering is also provider-neutral. One-attempt-per-
  runtime identity resolution and per-Agent profile mutation serialization live
  in a shared owner; Codex preview parsing and `/status` or `/model` commands
  remain provider policy and effects.
- ACP transcript projection owns prepared-cache identity, on-demand read
  coalescing, serialization, invalidation, prioritization, and exact Agent
  cleanup in one service. The Manager retains only live-Agent admission and
  transport-facing delegation.
- Terminal projection deduplication keeps the last published status and
  provider profile in one weakly keyed tracker. Event handlers compute current
  facts but do not own parallel projection caches.
- Live ACP session options, including MCP configuration that may contain
  credentials, live in a private exact-session-key store. The store clones on
  write and read and owns deletion/disposal; browser-facing Agent records never
  become an alternate source of truth.
- Agent session persistence owns runtime-owner validation, private ACP option
  projection, canonical-record rebinding, and order-index observation. Callers
  submit an exact Agent record and patch; they do not interpret store identity
  replacement or copy private session fields themselves.
- The lifecycle journal owner performs durable admission, transition,
  checkpoint, completion, rollback-on-write-failure, and Create-result
  recording and replay classification. Lifecycle execution and recovery may
  choose the next action, but they do not implement journal transactions or
  interpret Create-request history.
- The Main Page session index owns canonical key ordering and membership
  updates. Create, recovery, Archive, and Delete request membership changes
  without reading or rewriting Settings storage themselves.
- A recovery gate owns the pending/complete/failed lifecycle and the exact
  recovery failure. Callers either wait for an authoritative successful result
  or await settlement for shutdown; they do not combine promises with flags.
- A shutdown state owner controls concurrent Dispose joining, the irreversible
  cleanup boundary, retry admission, and final disposal. Callers query one
  shutdown phase instead of combining disposing, frozen, promise, and disposed
  fields.
- Heartbeat scheduling owns the timer and zombie-sweep cadence. The Manager
  handles one tick's domain effects, but it does not own timer handles or
  elapsed-sweep bookkeeping.
- Task history storage owns the bounded in-memory list and persistence rollback.
  Archive and Delete build history entries but do not replace or repair the
  owned list when a durable append fails.
- Main Agent identity and concurrent-start joining share one owner. The Manager
  decides whether a live Agent may become Main and publishes the resulting
  projection, but it does not store the selected identity or an in-flight start
  reservation separately.
- Provider adapters expose typed decisions such as permission restart,
  Terminal identity/startup constraints, idle stability, and conversation Fork
  policy. Generic lifecycle code does not interpret provider names. A shared
  Terminal startup coordinator owns mutable ordering and readiness state;
  adapters contribute stateless resource-scope and readiness policy only.

### ACP ownership

- Farming Server accesses ACP only through the ACP Host runtime contract.
- `AcpRuntime` remains the execution engine inside the ACP Host process; the
  goal is to remove the Server/AgentManager in-process fallback, not to delete
  the Host's engine.
- Engine session state and ACP Host controller/operation state have different
  owners. They stay distinct and use an explicit projection rather than being
  merged into one ambiguous state shape.

### Terminal ownership

- Checkpoint installation, ordered output, sequence gaps, resize transitions,
  and attachment generations form one ordering model.
- Touch physics and IME/DOM integration may be independent policies or
  adapters. Checkpoint and resize must not become competing state machines.
- The browser session registry is explicit and injectable while the existing
  public singleton API remains stable during migration.

### Frontend ownership

- React layout components do not own request races, retry generations,
  pagination reconciliation, or stale-response rejection.
- Controllers are organized by product domain, not as one wrapper per `fetch`.
  Each controller owns its request lifecycle and reducer together.
- Pure reducers define session inventory, pagination, Project operations, and
  other state transitions before UI props are narrowed.

## Current Convergence Assessment

Healthy boundaries now include Server transport, Worktree/Git effects,
provider-session identity, usage, adaptive titles, Settings, selected
WebSocket delivery owners, durable Fork admission/reconciliation with shared
no-replay restart convergence, one Fork child-start settlement rule, and thin
Resume transport over one domain coordinator. They
either removed the superseded production path or became the single owner of a
coherent state or effect.

The current priority structural problems are:

1. some `CodeWorkspace` controllers mirror backend truth or merely wrap a
   reducer or fetch;
2. Terminal link, resize, and attachment code use overlapping operation
   identities;
3. Attention/unread transitions have a tracker, but persistence/recovery
   projections and facade wrappers still split knowledge with the Manager;
4. stylesheet file ownership does not by itself prove cross-owner cascade
   equivalence.

Resume keeps two internal admission maps because an HTTP resume is a complete
operation while direct and auto resume are effect-level entries; whether they
can merge into one admission is unproven, not a known defect. Launch remains a
small composition boundary: provider adapters declare provider behavior,
executable discovery owns selection mechanics, and the Manager owns its one
shell-environment cache and assembles the launch request. Do not recreate a
large Launch service or port surface unless a smaller owner removes proven
duplicated truth.

No new large state extraction starts until these areas converge. An unmerged
prototype is evidence, not an asset that must be preserved. If it repeatedly
adds ledgers, registries, generations, latches, or compensating flags to pass
review, reduce it to a smaller state machine or discard it.

The domain state machine owns transition rules. Registries and stores own exact
identity and durable data, while effect executors report facts. One decision
must not be repeated by a coordinator, a lifecycle layer, and the Manager.

### Target roles for oversized hosts

- `agent-manager.cts` ultimately retains the exact Agent registry, public
  facade, service composition, and event delivery. Recovery/start/restart/
  archive/kill form one Agent-lifecycle domain. Fork and Project/Worktree are
  separate domains; neither may remain as a large inline block or a stateless
  wrapper around that block.
- `CodeWorkspace.tsx` retains page layout, current selection, browser-local
  workspace-surface state, and child composition. Composer may own drafts,
  menus, and attachment previews; Project membership, Agent lifecycle, and
  durable mutation outcomes project backend truth.
- `terminal-session-pool.ts` retains registry, bootstrap, attach/detach, and the
  stable public API. Checkpoint/output/reconnect form one replication
  capability, while selection/context-menu/IME/touch form one interaction
  capability. Both use one attachment-operation identity.
- CRT `app.ts` separates by real product surface: shell, Agent list,
  history/search, workspace launch, Billing, ACP Chat, and shared Terminal
  integration. Moving one contiguous block into a larger controller is not
  sufficient.
- `workspace-file-service.cts` remains a facade over path policy, file
  read/mutation, search, Git, and watcher executors. Those executors do not own
  product business state.
- `acp-runtime.cts` converges only along its two real authorities: the runtime
  process pool and each Agent's session binding. It does not create one service
  per ACP method.
- `AgentTranscriptPane.tsx` and `CodeSidebar.tsx` first split along existing
  React component boundaries without adding controllers or asynchronous state.
- `main.css` and `code-dark.css` split by rendered surface with global-cascade
  evidence; partition-local hashes, selector prefixes, and an import manifest
  are not sufficient proof.

## Continuous Integration Model

`main` is the only integration timeline. Refactor work happens in independent
worktrees, but completed slices merge continuously into current `main`. There
is no long-lived refactor integration branch.

### Implementation and review ownership

- One persistent implementation owner carries context across consecutive
  slices. It may delegate bounded investigations, but it remains responsible
  for one coherent proposal and worktree instead of handing each correction to
  a new writer.
- The implementation owner may challenge this plan and propose a simpler
  boundary. A different design is accepted when it removes more duplicated
  knowledge, preserves the invariants, and has stronger evidence.
- A separate integration reviewer controls objective, scope, process, and the
  final commit. Green focused tests are input to review, not authorization to
  merge.
- Review explicitly accepts, rejects, or redirects a slice. A rejected design
  is reduced or replaced at its owning invariant; it is not repaired by an
  open-ended sequence of maps, generations, latches, flags, and compatibility
  branches.
- The integration reviewer performs the final diff audit and commit so quality
  responsibility cannot be delegated to the implementation owner.

### Slice contract

Before an Agent starts a slice, its coordination record states:

- objective and explicit non-goals;
- exact base SHA;
- owned hotspot files and allowed new files;
- authoritative state owner and dependency direction;
- behavior or contract tests that prove equivalence;
- focused and final verification gates;
- expected merge window.

One hotspot file has one active writer. Parallel work is allowed only when
ownership lanes are genuinely disjoint. A feature change has priority when it
must touch the same hotspot; the refactor rebases after the feature lands or
first lands a small stable boundary that the feature can consume.

### Staleness budget

- A slice should merge within one working day and must be split if it cannot
  remain reviewable within two working days.
- Rebase at the start of each work session, after a relevant hotspot change on
  `main`, and immediately before final verification.
- If a branch is more than ten commits behind `main`, or any owned hotspot has
  changed semantically, stop expanding it and reconcile first.
- When reconciliation requires redesign rather than a mechanical rebase,
  replay the small intent on current `main`. An old prototype is evidence and a
  test source, not a second merge base.
- Delete merged worktrees and branches promptly so ownership is unambiguous.

### Merge shape

Prefer this sequence when practical:

1. Add characterization or contract tests for the existing behavior.
2. Introduce the pure policy, reducer, or narrow port.
3. Switch one caller and remove its superseded implementation.
4. Rebase current `main`, run the required gates, and merge immediately.

A slice normally contains one to three reviewable commits. A track is a queue
of such slices, not one long-running branch.

## Dependency Plan

The plan uses dependency gates rather than a big-bang wave. After the
foundation lands, disjoint lanes may run concurrently.

### Foundation — contract safety

The shared Agent snapshot/delta wire contract, the HTTP route manifest, and
typed WebSocket dispatch are established guards. Any remaining high-risk owner
move still requires an equivalent guard first: ACP Host contract tests for
Server-visible behavior, recovery, uncertain prompt/cancel outcomes, and exact
runtime identity; and characterization of the ordering, stale completion,
reconnect, and generation behavior of whatever state is about to move.

These are contract guards, not new compatibility layers.

### Lane F1 — Transcript pure logic

Independently testable transcript logic — file-link parsing and location
normalization, fetch retry policy, and reading-anchor capture and restoration —
belongs in pure modules. Rendering and live transcript orchestration stay in
the component until a later change proves another stable owner.

### Lane F2 — Workspace application controllers

`CodeWorkspace` delegates several domains, but controller count and total
production code have grown faster than host responsibility has fallen. The
next step is convergence, not further extraction:

1. retain owners of genuine browser-local Composer, workspace-surface, and
   session-view state;
2. merge or remove layers that only wrap reducers, fetches, or backend truth;
3. project authoritative Project and Agent mutation results instead of keeping
   parallel frontend admission, deadline, and reconciliation state;
4. narrow props only after the remaining owners are stable.

### Lane F3 — Terminal browser runtime

The browser runtime has an injectable Session registry, one attachment
coordinator for checkpoint ordering and admission, ordered output, gaps and
attachment generation, shared Code/CRT replay, renderer, link, input and
recovery owners. The Session pool still owns checkpoint install effects,
request retry, and DOM-write completion. Remaining scope within this single
ownership lane:

1. converge link, resize, and renderer identity onto one attachment operation;
2. remove duplicate commit latches, revisions, and production-resident
   projections used only by E2E;
3. then move replication (checkpoint/output/reconnect) and interaction
   (selection/context menu/IME/touch) by actual capability;
4. leave the pool as registry, bootstrap, attach/detach, and stable public API.

Code and CRT Terminal protocol E2E coverage is required for each slice.

### Lane B1 — Server transport boundaries

`server.cts` is bootstrap with a route manifest, typed WebSocket dispatch, and
domain routers and WebSocket handler groups for session inventory and search,
Settings, Agent and Project mutations, Agent lifecycle, and ACP interaction. The
Agent-state broadcast scheduler is already an owner in this transport lane and
is the single owner of coalescing and scheduling Agent-state delta mutation
intent; the authoritative projection and tracker stay outside it.

Per-client Agent-state snapshot delivery has its own connection-scoped owner,
`WebSocketAgentStateSnapshotController`. It owns the per-client cut serial,
paging and backpressure, deferred delivery, restart and overflow handling,
bounded failure and cleanup, and the Activity/ACP/Preview completion barrier
that holds those follow-up recovery deliveries behind completion of the
client's authoritative snapshot cut and releases them once that cut is
complete. The authoritative projection and the broadcast scheduler remain
outside that boundary.

Remaining scope:

- extract the remaining bounded bootstrap domains — ACP Agent HTTP operations,
  usage and update operations, auth/share/static groups — where separation is
  useful.

Avoid one file per message. Each slice must preserve the route manifest,
middleware order, response shape, and connection-local state.

### Lane B2 — Agent application services

Slices touching `agent-manager.cts` remain serialized. Usage-rate accounting,
adaptive title persistence, Worktree/Git operations, Composer admission,
durable Fork admission/reconciliation, Resume coordination, and cross-runtime
per-Agent input ordering have owners. Terminal resize latest-value coalescing
and drain state also have one owner, separate from the engine resize effect.
Shell-environment resolution owns its provider, bounded cache, expiry, and
cleanup outside the Manager. Activity timestamps and throttled activity
publication likewise have one tracker owner. ACP settled-Turn finalization now
owns its per-Agent admission/tails, runtime fencing, durable convergence,
Attention publication, drain, and exact cleanup as one state machine.
The Manager calls the Attention tracker directly internally; redundant facade
wrappers are not retained as a second pseudo-owner.
Worktree refresh coalescing and generation fencing are now owned together, so
delete/reuse invalidates both pending and already active observations.
Provider-neutral Terminal startup ordering also has one owner, activated by a
typed adapter policy rather than a provider-name branch. Launch composition
remains in the Manager over provider-adapter and executable discovery
boundaries. Remaining scope:

1. keep the shared Fork child-start settlement narrow. Worktree and Provider
   Session rollback remain resource-specific; do not replace them with a
   generic rollback executor unless their retained-resource semantics become
   provably identical;
2. touch Resume again only with concrete duplicated-truth evidence, such as one
   request admitted under two signature definitions; move Launch composition
   only when a smaller boundary demonstrably removes provider or executable
   knowledge instead of wrapping it in ports;
3. converge Attention/unread persistence, recovery projection, and facade
   delegation around the existing tracker, then move runtime/record types with
   their owner;
4. leave the facade with exact registry, public entry points, service
   composition, and event delivery.

Line count is not an acceptance criterion. A service is accepted only if it
reduces the Manager's knowledge and can be tested without constructing the
complete Manager.

### Lane B3 — ACP Host convergence and provider policy

This lane shares the AgentManager hotspot with B2 and therefore runs serially
with conflicting B2 slices, but it does not wait for every extraction to
finish:

1. make the ACP Host runtime contract the only default Server-facing path;
2. replace tests that rely on the direct in-process fallback with explicit
   runtime fakes or a Host harness;
3. remove the AgentManager fallback construction while retaining
   `AcpRuntime` inside the Host process;
4. define and test the projection between engine session state and Host
   controller/operation state;
5. absorb provider special cases incrementally into typed adapter policies.

This lane requires real-provider smoke verification for every supported
provider whose runtime behavior is touched.

### Supporting helpers

Do not create a generic backend utility collection. Share only proven repeated
boundaries in focused modules, for example record guards, bounded waits, or
process execution. Trivial duplication may remain when centralization would
increase coupling.

## Continuation Priorities

Continue the remaining work as small slices in the following dependency order.
This list records unfinished architectural outcomes rather than a branch or
file-by-file progress log:

1. Audit and converge the existing `CodeWorkspace` and Terminal owners first,
   or land strictly behavior-neutral physical splits along already visible
   component boundaries. Remove frontend mirrors of backend truth and
   wrapper-only controllers; unify Terminal attachment-operation identity
   before moving replication and interaction.
2. For AgentManager, converge Attention/unread around its existing tracker.
   Keep Fork resource rollback exact and separate, and do not continue Resume
   or Launch without concrete duplicated-truth evidence.
3. Reassess unmerged stylesheet and CRT prototypes. Merge only when the
   production boundary is real, total code remains justified, and one-time
   old/new behavior evidence passes; otherwise reduce or discard them.
4. Finish the remaining Server transport and ACP work. Extract the remaining
   bounded HTTP and bootstrap domains while preserving auth, middleware order,
   route shapes, and connection-local state, and converge on the ACP Host-only
   Server path: remove the in-process fallback once deterministic Host fakes or
   a harness cover recovery and uncertain prompt/cancel outcomes, keep engine
   state separate from Host operation state through an explicit projection, and
   run the required real-provider smokes.
5. Retire obsolete compatibility code continuously. A compatibility alias,
   adapter, fallback, parser branch, or old state shape may be removed only
   after repository-wide call-site analysis and boundary tests show that no
   supported client, protocol version, persisted data, extension, or public API
   still depends on it. Delete the obsolete path and its compatibility-only
   tests together in a small behavior-neutral slice; do not preserve unreachable
   code merely because it once supported an older implementation, and do not
   classify an active system-boundary adapter as dead code from static imports
   alone.
6. Continue stylesheet decomposition only with global-cascade evidence, not
   partition-local selector hashes alone. Split the remaining product domains
   out of the main and dark-skin stylesheets with cascade, specificity, and
   import-order proof.
7. Integrate continuously. Rebase each reviewable slice onto current `main`, run
   its focused state-machine tests, then run the full typecheck, lint, test, and
   applicable Server, Terminal, Playwright, or provider gates before merging.
   Do not accumulate these priorities into another long-lived integration
   branch.

### Stylesheet ownership

The product-domain decomposition of the application stylesheets is complete:
every product domain - File Editor, Pet, Git History, Composer, Plugin,
Settings, Share, sidebar resources, Usage, Markdown, Search, History, empty
states, Language Server, desktop backend, Terminal, workspace Files, Sidebar,
transcript, and Agent list - has its own base and dark owner pair declared in
the style-source manifest and guarded by a domain ownership contract test.
`main.css` and `code-dark.css` retain only application-level chrome and shared
base layout, which is their intended durable scope.

For any future domain split or style change, keep the established rules:
split by product domain and rendered surface, not by arbitrary line count;
move the domain's base rules, dark-skin overrides, responsive rules,
animations, and style-contract tests together while preserving runtime import
order, cascade, specificity, and visual behavior. Theme tokens and independent
skins remain separate owners. Source-contract tests read the declared
style-source manifest and must not freeze foreign monolith content, which
would tax every later extraction and feature change. Remove an obsolete
selector only after component-source and rendered-DOM evidence show that no
supported state, extension, or responsive layout can produce it; visible
slices require focused desktop, dark, and narrow-layout verification.

## Verification

Every slice defines focused gates from its state model. The default final gates
are:

```bash
npm run typecheck
npm run lint
npm test
```

Additionally:

- Server router or WebSocket changes run server lifecycle and protocol tests
  with `FARMING_INCLUDE_SERVER_TESTS=1`.
- Terminal changes run Code and CRT checkpoint, reconnect, resize, IME, TUI,
  and multi-viewer scenarios.
- Agent lifecycle, Worktree, Fork, or ACP changes test cancellation,
  concurrency, uncertain outcomes, restart, recovery, and exact cleanup.
- Visible frontend changes run focused Playwright scenarios in desktop and
  narrow layouts where the interaction exists.
- ACP Host and provider-policy changes run isolated, low-volume real-provider
  smokes after deterministic tests pass.

Tests may move or gain direct imports when code moves, but behavioral
assertions must not be weakened merely to accommodate the extraction.

## Completion Criteria

The strategy is complete when all of the following are true:

- Server bootstrap primarily mounts middleware, routers, and WebSocket domain
  handlers; route contracts remain unchanged.
- `AgentManager` is a facade over named owners and does not contain provider
  behavior decisions or embedded Worktree/Attention implementations.
- Farming Server reaches ACP only through the Host contract; the Host retains
  its execution engine and authoritative operation journal.
- Terminal checkpoint, output, gap, resize, and attachment ordering have one
  browser-side coordinator and one testable registry.
- `CodeWorkspace` renders domain-controller state and no longer owns raw
  paging, stale-response, or Project mutation state machines.
- Transcript parsing, retry policy, and reading anchors are independently
  tested pure modules.
- Shared wire contracts have one definition at the system boundary.
- A normal feature in any of these domains changes one owner and its tests
  rather than several unrelated giant files.

## Rejected Patterns

- long-lived integration branches or a final big-bang merge;
- refactor and product behavior changes in the same slice;
- one wrapper per request or one module per WebSocket message;
- capability-flag proliferation that merely hides provider-name switches;
- a generic `utils` module containing unrelated helpers;
- passing the complete Manager into every extracted service;
- separate checkpoint and resize owners with overlapping ordering state;
- dual production implementations kept as fallback without equivalent tests;
- line-count reduction used as proof of architectural improvement;
- repeatedly adding ledgers, registries, generations, revisions, latches, or
  dynamic error flags to answer review findings without revisiting ownership;
- production APIs used only by tests, or source-string and same-source manifest
  assertions treated as primary correctness evidence.

CRT/Code unification, broad tsconfig changes, and unrelated product redesigns
remain out of scope. They require their own contracts and acceptance plans.
