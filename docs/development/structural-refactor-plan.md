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
- Fork remains orchestration until Worktree, lifecycle persistence, and ACP
  runtime ports are narrow enough for a `ForkCoordinator` with explicit inputs,
  effects, rollback, and uncertain outcomes.
- Provider adapters expose typed decisions such as permission restart,
  Terminal identity, idle stability, and conversation Fork policy. Generic
  lifecycle code does not interpret provider names.

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

## Continuous Integration Model

`main` is the only integration timeline. Refactor work happens in independent
worktrees, but completed slices merge continuously into current `main`. There
is no long-lived refactor integration branch.

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

Land these guards before moving high-risk owners:

1. Co-locate the Agent state snapshot/delta wire contract in `shared/` and add
   parity tests for backend projection and browser reduction.
2. Add an HTTP route manifest test covering method, path, registration order,
   and important middleware/error shapes before router extraction.
3. Replace the WebSocket switch's implicit completeness with a typed dispatch
   table and tests that every negotiated client message has one handler.
4. Add ACP Host contract tests for Server-visible behavior, recovery,
   uncertain prompt/cancel outcomes, and exact runtime identity.
5. Characterize Terminal checkpoint/output/resize ordering, stale completion,
   reconnect, and attachment generation before moving that logic.

These are contract guards, not new compatibility layers.

### Lane F1 — Transcript pure logic

Extract independently testable logic from `AgentTranscriptPane` in small
slices:

1. file-link parsing and location normalization;
2. transcript fetch retry policy;
3. reading-anchor capture and restoration.

Rendering and live transcript orchestration stay in the component until a
later change proves another stable owner. Existing prototype work must be
reconciled onto current `main`, not merged through an old integration branch.

### Lane F2 — Workspace application controllers

Refactor `CodeWorkspace` by domain:

1. extract the session inventory and `mainPageSessionKeys` reconciliation as a
   pure reducer with illegal-sequence tests;
2. introduce a Session inventory controller that owns paging, cancellation,
   generation checks, and request errors;
3. introduce Project operations, Settings/catalog, and Resume/share
   controllers only where each has a coherent lifecycle;
4. narrow component props after ownership has moved.

Do not create a collection of stateless `api-*` wrappers whose only effect is
moving `fetch` calls to another file.

### Lane F3 — Terminal browser runtime

Run these slices in order within one ownership lane:

1. extract and test touch-scroll physics;
2. isolate IME and DOM input integration behind a small adapter;
3. wrap the module-global Session map in an injectable registry while
   preserving the current exported API;
4. extract one Terminal attachment coordinator that owns checkpoint install,
   ordered output, gaps, resize, and attachment generation;
5. move diagnostics and test bridges after the production state owner is
   stable.

Terminal protocol E2E coverage for Code and CRT is required after steps 3 and
4.

### Lane B1 — Server transport boundaries

Keep `server.cts` as bootstrap and extract one domain at a time:

- Session inventory and search;
- ACP Agent HTTP operations;
- Agent and Project mutations;
- Settings, themes, usage, and update operations;
- remaining bounded auth/share/static bootstrap groups where separation is
  useful.

WebSocket handlers are grouped by protocol domain—handshake/health, Agent
lifecycle, Terminal, ACP interaction, focus/scope, and workspace resources.
Avoid one file per message. Each slice must preserve the route manifest,
middleware order, response shape, and WebSocket behavior.

### Lane B2 — Agent application services

Serialize slices that touch `agent-manager.cts`:

1. usage-rate accounting as a bounded pure projection;
2. Attention/unread as a documented state machine with a narrow host port;
3. Worktree/git operations and proven postconditions as a service;
4. move runtime and record types with their new owners instead of performing a
   final repository-wide type shuffle;
5. extract Composer or Fork orchestration only after their dependency ports
   are narrow and their state-transition models are explicit.

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

1. Complete the Terminal attachment coordinator. Checkpoint installation,
   ordered output, sequence gaps, resize transitions, and attachment
   generations must have one ordering owner. Existing registry, resize, input,
   and recovery policies remain subordinate collaborators instead of becoming
   competing state machines. Completion requires production-shaped Code and
   CRT reconnect, stale-completion, gap, resize, and multi-viewer coverage.
2. Finish coherent Workspace controllers. Move the remaining Project mutation,
   Settings, Resume, and Share request lifecycles out of layout components only
   when each controller can own admission, cancellation, stale-response
   rejection, reconciliation, and terminal failure. Afterward, narrow component
   props around those owners; do not replace inline requests with stateless API
   wrappers.
3. Finish the remaining Server transport domains. Extract Agent and Project
   mutations, ACP Agent operations, Settings, attachments, and the remaining
   WebSocket Agent-lifecycle and ACP-interaction groups while preserving auth,
   middleware order, route shapes, and connection-local state. Slices that
   depend on AgentManager or ACP internals wait until those hotspots have one
   writer.
4. Continue AgentManager service extraction serially. Extract Worktree and Git
   operations with explicit postconditions first, move runtime and record types
   with their owners, then introduce Composer or Fork orchestration only after
   lifecycle, persistence, Worktree, and ACP ports are narrow enough to model
   rollback and uncertain outcomes without receiving the complete Manager.
5. Converge on the ACP Host-only Server path. Remove the in-process Server
   fallback after deterministic Host fakes or a harness cover recovery and
   uncertain prompt/cancel outcomes; keep engine state separate from Host
   operation state through an explicit projection, and move provider decisions
   into typed adapter policies. Run the required real-provider smokes for every
   affected provider.
6. Integrate continuously. Rebase each reviewable slice onto current `main`, run
   its focused state-machine tests, then run the full typecheck, lint, test, and
   applicable Server, Terminal, Playwright, or provider gates before merging.
   Do not accumulate these priorities into another long-lived integration
   branch.

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
- line-count reduction used as proof of architectural improvement.

CRT/Code unification, broad tsconfig changes, and unrelated product redesigns
remain out of scope. They require their own contracts and acceptance plans.
