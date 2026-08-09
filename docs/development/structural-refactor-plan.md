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
- Fork is owned by a coordinator with explicit inputs, effects, rollback, and
  uncertain outcomes over narrow Worktree, lifecycle-persistence, and ACP
  runtime ports. Remaining Manager domains follow the same port discipline.
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

`CodeWorkspace` already delegates session inventory, Project membership and
mutation, Settings, Resume and QR share, queued Composer follow-ups, and
resource/workspace-surface restoration to domain owners. Remaining scope:

1. move each remaining cohesive layout-owned domain to a controller that owns
   admission, cancellation, generation checks, stale-response rejection,
   reconciliation, and terminal failure;
2. narrow component props around the established owners.

Do not create a collection of stateless `api-*` wrappers whose only effect is
moving `fetch` calls to another file.

### Lane F3 — Terminal browser runtime

The browser runtime has an injectable Session registry, one attachment
coordinator for checkpoint ordering and admission, ordered output, gaps and
attachment generation, shared Code/CRT replay, renderer, link, input and
recovery owners. The Session pool still owns checkpoint install effects,
request retry, and DOM-write completion. Remaining scope within this single
ownership lane:

1. converge resize and renderer-effect orchestration onto the attachment
   ordering model instead of parallel effect chains;
2. slim the Session pool to an integration boundary once another stateful
   collaborator can move without copying renderer or protocol truth.

Code and CRT Terminal protocol E2E coverage is required for each slice.

### Lane B1 — Server transport boundaries

`server.cts` is bootstrap with a route manifest, typed WebSocket dispatch, and
domain routers and WebSocket handler groups for session inventory and search,
Settings, Agent and Project mutations, Agent lifecycle, and ACP interaction. The
Agent-state broadcast scheduler is already an owner in this transport lane and
is the single owner of coalescing and scheduling Agent-state delta mutation
intent; the authoritative projection and tracker stay outside it, and the
pending per-client snapshot lifecycle remains a separate concern. Remaining
scope:

- give per-client initial snapshot delivery an explicit connection-scoped
  lifecycle owner with bounded failure;
- extract the remaining bounded bootstrap domains — ACP Agent HTTP operations,
  usage and update operations, auth/share/static groups — where separation is
  useful.

Avoid one file per message. Each slice must preserve the route manifest,
middleware order, response shape, and connection-local state.

### Lane B2 — Agent application services

Slices touching `agent-manager.cts` remain serialized. Usage-rate accounting,
adaptive title persistence, Worktree/git operations, Fork coordination, and
Composer admission have owners. Remaining scope:

1. Attention/unread as a documented state machine with a narrow host port;
2. launch environment and provider policy resolution as typed decisions rather
   than inline Manager knowledge;
3. move runtime and record types with their owners instead of performing a
   final repository-wide type shuffle;
4. slim the remaining facade until it holds exact identity and top-level
   lifecycle admission only.

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

1. Give per-client initial Agent snapshot delivery one connection-scoped
   lifecycle owner. Delivery, scope change or resynchronization, and failure
   must be bounded and explicit per client while the Agent broadcast scheduler
   stays the single owner of coalescing and scheduling Agent-state delta
   mutation intent.
2. Finish the bounded remaining Workspace and Terminal owners. For Workspace,
   move the remaining cohesive layout-owned domains and then narrow props
   around the established owners. For Terminal, converge resize and
   renderer-effect orchestration onto the attachment ordering model and slim
   the Session pool to an integration boundary. Preserve production-shaped Code
   and CRT reconnect, stale-completion, gap, resize, and multi-viewer coverage.
3. Move Agent launch environment, provider policy resolution, and
   attention/unread out of the Manager as typed decisions and a documented
   state machine over narrow host ports, then slim the remaining facade to
   exact identity and top-level lifecycle admission.
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
6. Continue stylesheet decomposition alongside the code hotspots. Split the
   remaining product domains out of the main and dark-skin stylesheets with
   cascade, specificity, and import-order proof.
7. Integrate continuously. Rebase each reviewable slice onto current `main`, run
   its focused state-machine tests, then run the full typecheck, lint, test, and
   applicable Server, Terminal, Playwright, or provider gates before merging.
   Do not accumulate these priorities into another long-lived integration
   branch.

### Stylesheet ownership

Oversized application stylesheets are an independent supporting lane and may
be decomposed while code hotspots are busy. Git History, Composer, Plugin,
Settings, Share, and Pet surfaces already have their own style owners; the main
and Code dark-skin stylesheets still need their remaining product-domain splits.
Split styles by product domain and rendered surface, not by arbitrary line
count. A slice moves the domain's base
rules, dark-skin overrides, responsive rules, animations, and style-contract
tests together while preserving runtime import order, cascade, specificity, and
visual behavior. Theme tokens and independent skins remain separate owners.
Source-contract tests should read a declared style-source manifest instead of
assuming every selector lives in one monolithic file. Remove an obsolete
selector only after component-source and rendered-DOM evidence show that no
supported state, extension, or responsive layout can produce it; visible slices
require focused desktop, dark, and narrow-layout verification.

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
