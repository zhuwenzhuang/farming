# AGENTS.md - Repository Development Guide

> Chinese version: [AGENTS.zh_cn.md](./AGENTS.zh_cn.md)

This file gives repository-wide instructions for AI agents and contributors
working on Farming.

## Scope Of This File

Keep this file short, durable, and broadly applicable. It should contain only:

- the product intent needed to make engineering decisions;
- repository-wide architecture and ownership boundaries;
- cross-cutting engineering, documentation, and verification rules;
- a map to the canonical detailed documentation.

Do not put feature specifications, field inventories, exact state machines,
release runbooks, temporary debugging notes, or completed-work history here.
Put them in the relevant product or development document, code and tests,
release notes, or an issue. When a rule applies only to one subtree, prefer a
closer `AGENTS.md` in that subtree.

English is the default public documentation language. Keep this file and
`AGENTS.zh_cn.md` semantically aligned.

## Product Intent

Farming is a browser-based workspace for supervising AI coding agents. Its
primary design constraint is human attention: users should be able to notice
important work, understand current state, and intervene without repeatedly
switching among terminals, editors, browsers, and monitoring pages.

Farming Code is the default interface. Farming CRT is a second live interface
over the same backend sessions. Farming Net is a separate deployment directory
for opening trusted Farming instances and must remain isolated from the main
runtime's configuration and credentials.

Prefer:

- clear Project and Agent grouping;
- compact controls and stable layouts;
- visible feedback for every action;
- keyboard access to important operations;
- explicit, bounded failure over a silent low-quality fallback;
- interfaces that help the user supervise rather than maximize visible state.

Preserve the existing visual style and product wording when fixing behavior
unless the requested change has a clear visual or product-copy reason.

Treat interaction-state styling as a product-wide contract, not a local
component detail. Selected, active, focused, hovered, pressed, loading,
disabled, success, warning, and error states must use a coherent visual
language across related rows, lists, tabs, menus, editors, and appearances.
Review the composed interface and simultaneous states before accepting a local
style change; the same semantic state should share tokens and hierarchy unless
a documented product reason requires otherwise.

Do not use a left-side line, bar, border, rail, or equivalent edge marker to
indicate a selected or active row. Use the shared selection surface, text, or
icon treatment instead, and avoid stacking multiple competing selection cues
on the same item.

Within the same selectable Project, Agent, file, or tab collection, hovered
and selected items use the same surface color. Do not introduce a second fill
color merely to distinguish pointer hover from selection.

A visually continuous control or state surface must use one outer corner
geometry. Its base, hover or selection fill, overlay, and action layers must
preserve the same outer radius; do not leave one end square and the other
rounded unless it is an explicitly designed joined-control group.

## Start With Canonical Context

Before changing a subsystem, read its current code, tests, and canonical
document. Start at [Development Documentation](docs/development/README.md).
Important entry points include:

- [ACP runtime](docs/products/code/acp-runtime.md)
- [Codex runtime](docs/products/code/codex-runtime.md)
- [Terminal state protocol](docs/products/code/terminal-state-protocol.md)
- [Extension and Resource model](docs/products/code/extension-model.md)
- [Project Files design](docs/products/code/project-files-section-design.md)
- [Package installation lifecycle](docs/development/package-installation-lifecycle.md)
- [Config instance isolation](docs/development/config-instance-isolation.md)
- [Farming Net guide](docs/products/net/guide.md)
- [Acceptance and dogfood plan](docs/products/code/test/acceptance-dogfood-plan.md)

Treat those documents as the owners of subsystem-specific contracts. Update
the owning document when a durable product, architecture, interaction, or
verification contract changes. Do not copy its detailed rules back here.

## Architecture Boundaries

```text
Browser interfaces
  React / Vite / Monaco / terminal renderer
          |
          | HTTP and versioned WebSocket protocols
          v
Farming backend
  auth / lifecycle / sessions / files / history / configuration
          |
          | native PTY host and provider adapters
          v
Execution environment
  shells / coding agents / optional Browser and Computer resources
```

- The backend owns authoritative lifecycle, runtime, authentication, session,
  workspace, usage, and configuration state. Frontends present that state and
  must not reconstruct backend truth from terminal text or stale UI data.
- Interactive terminals use the native PTY host as the product path. Debug
  implementations are not automatic product fallbacks.
- Structured coding-agent Chat uses ACP through provider adapters. Keep
  provider-specific discovery, capability, executable, and session behavior at
  that boundary rather than scattering provider-name checks through generic
  lifecycle or UI code.
- Cross-cutting performance, correctness, reliability, recovery, resource
  isolation, and observability improvements must apply to every supported
  Agent and provider through provider-neutral contracts and equivalent
  acceptance criteria. Provider differences belong in adapters; a
  provider-specific implementation is not a completed system optimization.
- Executable ownership is runtime-mode-specific: native Terminals prefer the
  user's system executable, selecting a verified Farming-owned executable only
  when it is strictly newer; ACP uses Farming-owned, pinned adapter/runtime
  artifacts independently of Terminal resolution. Keep ACP pins current and
  verify Chat/Terminal switching against the selected provider versions.
- Browser and Computer capabilities live in `extensions/` and must compose the
  shared Resource and protocol contracts. Do not create a second untested
  implementation of a supported capability.
- A view that claims to show current capability, inventory, configuration, or
  health must perform a fresh authoritative read with bounded loading and
  explicit failure. Background-prefetched data may support navigation, but it
  is not automatically current-state evidence.
- Keep one source of truth for each identity and state transition. Compatibility
  shapes belong at system boundaries and must not leak into new feature code.

## Engineering Rules

- Keep changes scoped to the request and preserve unrelated worktree changes.
- Prefer existing patterns and local helpers. Add abstraction only when the
  current change proves a stable repeated boundary.
- Validate input at the boundary and return actionable errors.
- Use asynchronous I/O on server paths. Keep expensive filesystem and CLI work
  bounded; reuse the repository's caching patterns where they already apply.
- Do not hard-code secrets, private hosts, personal paths, or machine-specific
  assumptions. Keep filesystem operations inside their authorized workspace or
  config root.
- Keep Agent processes and Config instances isolated. Resolve process,
  workspace, session, and external-resource ownership by exact identity before
  mutating or cleaning them up.
- Farming has exactly one intentional stop semantic: directly kill the complete
  set of Farming-owned processes selected by that stop. Do not add graceful
  shutdown or drain, handoff, process preservation or reuse, or an alternative
  stop mode. This single hard-stop contract deliberately simplifies state
  management; the next start must recover as after abrupt process loss. This is
  a state-machine correctness constraint, not merely an implementation
  shortcut: graceful termination would add a second termination scenario and
  can hide failures exposed by abrupt loss. Recovery and cleanup correctness
  must be proven against the hard-stop path. `npm restart` is a full Farming
  stop followed by a fresh start. Compatible Server-only reconnection is
  failure-recovery behavior, not a stop semantic.
- Treat an ambiguous timeout or transport failure as an uncertain outcome.
  Reconcile from authoritative state; do not automatically replay a mutation
  unless its protocol explicitly proves replay safety.
- For every non-trivial feature, write down the minimal state-transition model
  before implementation: authoritative owner, triggers, guards, effects,
  terminal failures, retry and cancellation, concurrency, and recovery.
- When a race is found, first identify why the architecture or code allowed it:
  an incomplete state machine, unclear ownership or ordering, or an imprecise
  fallback. Fix the violated invariant at its owning boundary. Do not conceal
  uncertain state with retries, fallback values, extra flags, or compensating
  branches that make the state machine more complex without proving correctness.
- Establish both safety and liveness. Illegal states must be rejected, and each
  transient state must have a bounded path to success, failure, cancellation,
  timeout, or recovery.
- Prefer one continuously tested product path. A fallback is supported behavior
  only when it can meet the same acceptance bar as the primary path.
- Do not weaken a type boundary with `any`, `@ts-nocheck`, or an equivalent
  escape solely to make a check pass.
- Do not edit generated runtime outputs when an authoritative source exists.
  Change the source and run the corresponding build script.

## Repository Map

- `backend/`: server, lifecycle, session engines, provider adapters, stores, and
  backend tests.
- `src/`: Farming Code React application and shared UI state.
- `frontend/`: Farming Net, CRT, and classic browser runtime sources.
- `extensions/`: optional Browser and Computer capabilities.
- `shared/`: browser/backend protocol contracts.
- `tests/e2e/`: browser, interaction, and visual tests.
- `scripts/`: build, packaging, release, smoke, and test orchestration.
- `docs/`: user, product, development, operations, and verification documents.
- `docs-site/`: standalone public documentation site with its own dependencies.
- `release-notes/`: versioned public release notes.

Generated and local-only paths such as `dist/`, `dist-release/`, `.tmp/`,
`reference/`, and `node_modules/` must not be committed.

## Documentation Rules

Update documentation in the same change when behavior or structure changes:

- Keep documentation edits minimal and local to the requested behavior. Unless
  the user explicitly asks for a redesign or rewrite, do not opportunistically
  reorganize information architecture, replace page structure or visual design,
  or substantially rewrite existing content while adding a feature or release
  note.

- `README.md`: top-level product promise, primary setup, and first-use path;
- `docs/README.md`: short public documentation index;
- `docs/products/*/README.md`: short product landing pages;
- `docs/products/` and `docs/development/`: durable design, architecture,
  state-machine, failure, recovery, and verification contracts;
- `CONTRIBUTING.md`: contributor setup and ordinary contribution workflow;
- `release-notes/`: shipped, version-specific user-visible changes;
- `AGENTS.md`: repository-wide instructions only.

Public documentation defaults to English with a sibling `.zh_cn.md` version and
reciprocal links. Do not publish conversation logs, transient investigations,
private deployment details, or implementation trivia that is better expressed
by code and tests.

Durable documentation describes architecture elements, ownership boundaries,
state transitions, failure and recovery semantics, interaction design, and
acceptance criteria. Do not maintain file-by-file change maps, class/function
inventories, test-file catalogs, or prose copies of current control flow. Put
those details in code, tests, commits, issues, or purpose-built execution
runbooks. Delete a document whose only purpose is to narrate the current
implementation; when a mixed document is still useful, keep the durable design
contract and remove the implementation inventory.

## Verification

Use the smallest useful checks while iterating, then run all checks justified
by the risk and affected surfaces. Common gates are:

```bash
npm test
npm run typecheck
npm run lint
npm run build
npm run test:e2e:playwright
```

- Backend tests live in `backend/tests/`; browser and visual tests live in
  `tests/e2e/`.
- Derive tests from the state model, including risky illegal sequences,
  concurrency, cancellation, reordering, reconnect, and restart where relevant.
- Use deterministic fake agents for routine automation. Real-provider smokes
  must be explicit, low-volume, and isolated.
- Every test and reproduction must clean up the exact temporary directories,
  sockets, processes, containers, and fixtures it creates, including failure
  paths. Never compensate with a broad recursive cleaner.
- Small synthetic fixtures are useful for the first pass. Before accepting a
  non-trivial UI or runtime change, also exercise a production-shaped scenario
  that combines the affected surfaces.
- For visible interaction changes, verify the real UI and update focused
  Playwright screenshots when practical.

See [Contributing](CONTRIBUTING.md) for the ordinary workflow and the canonical
development and product documents for subsystem-specific gates.

## Public And Release Hygiene

- Do not commit release binaries, secrets, tokens, real environment files,
  internal hosts, private links, personal machine paths, or private registries.
- Keep configuration examples generic.
- Use anonymous demo workspaces and example hostnames in screenshots.
- Build and publish through repository scripts and workflows; do not commit
  generated release artifacts.
