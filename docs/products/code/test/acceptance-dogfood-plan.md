# Farming Acceptance And Dogfood Plan

> Chinese version: [acceptance-dogfood-plan.zh_cn.md](./acceptance-dogfood-plan.zh_cn.md)

This runbook defines how Farming is accepted as a real multi-Agent workspace.
Automation proves repeatable contracts; dogfood proves that the combined product
is understandable, responsive, and recoverable in production-shaped use.

## Acceptance Questions

Each round must answer:

1. Can a user open a local or remote workspace from desktop and phone and
   supervise several Agents?
2. Do Chat, Terminal, Files, Review, History, Browser, Computer, settings, and
   updates agree on authoritative Agent and Session state?
3. Are reconnect, restart, cancellation, archive, process exit, weak network,
   and uncertain outcomes visible and recoverable?
4. Does performance remain acceptable as Agent and Session counts grow?
5. Does the interface reduce attention cost rather than create duplicate or
   misleading state?

## Test Layers

| Layer | Typical frequency | Purpose |
| --- | --- | --- |
| Static, unit, and protocol tests | every change | state transitions, validation, ownership, reducers |
| Deterministic browser tests | affected UI changes | repeatable user flows with fake Agents |
| Product-shaped integration | non-trivial runtime or UI changes | combined backend, browser, files, and lifecycle behavior |
| Real-provider smoke | before merge or release | login, real CLI/ACP behavior, resume, switching |
| Long soak and scale | explicit or overnight | duration, reconnect, memory, navigation latency, many Agents |

## Behavior-first Development Contract

User-visible work starts with a scenario stated as observable Given/When/Then
conditions. A regression fix first adds the smallest failing behavioral test,
then changes the implementation, then adds or updates one deterministic browser
journey when the defect crossed UI or subsystem boundaries. Gherkin or a separate
BDD framework is optional; scenario clarity and executable outcomes are required.

Use three complementary seams:

1. A pure state-transition test covers ordering, guards, retries, cancellation,
   and recovery without rendering.
2. A public boundary test drives the exported service, HTTP protocol, or rendered
   control and asserts outputs or accessible UI state.
3. A Playwright journey drives visible user actions for critical cross-surface
   behavior and verifies the final observable effect, persistence, and restoration.

Tests that read production source and search for identifiers may enforce a narrow
architecture or packaging boundary, but they are not evidence for UI behavior.
Do not add source-text assertions for state transitions, rendering, navigation,
focus, pagination, or recovery. Replace such assertions with imported state tests,
public-boundary tests, or browser journeys as the affected area changes.

Critical promises are registered in `tests/behavior-contracts.json`. Each contract
has a stable ID, observable promise, owning design document, and executable
evidence. A UI contract must name a Playwright journey tagged with both
`@critical-behavior` and its contract ID; the contract validator rejects missing,
unregistered, or source-inspection evidence. CI runs this set as the named
**Critical behavior** gate in addition to the complete sharded browser suite, so a
refactor cannot hide a known product regression inside a broad green structural
test. Promote a scenario into this registry when its failure would silently change
a durable cross-surface interaction or lifecycle guarantee.

Real-provider tests are explicit, low-volume, and isolated. They must not reset
quotas, rewrite provider login or defaults, or launch broad unrelated work.

## Target Environments

Use at least:

- the developer platform for fast iteration;
- a Linux host or container for installation, remote use, and runtime checks;
- a phone-sized browser viewport for supervision and short intervention;
- macOS Desktop when Electron or native integration changes.

Record the Farming revision and installation form, operating system, Node/npm
versions, provider executable paths and versions, Config directory, base path,
authentication mode, and whether the target is local or remote.

Private hostnames, tokens, and user content stay out of committed reports.

## Isolation And Cleanup

Every automated or Agent-driven story uses an isolated:

- Config directory and browser context;
- workspace and port;
- server log and artifact directory;
- provider Home when the story must not use the user's existing Session store.

A test launched from a live Farming Agent must not inherit the parent Farming
Config. Each story cleans up the exact processes, sockets, temporary files,
containers, Browser/Computer Resources, and provider Sessions it creates,
including failure paths. Broad recursive cleanup is not acceptable.

## Scenario Matrix

### Startup, Connection, And Update

Verify first launch, authenticated URL, base path, port conflict, duplicate
Config ownership, local and remote connection, reconnect, update preparation,
restart, rollback, and explicit failure for missing dependencies. A partial or
uncertain start must not create a second daemon or lose the last known good
installation.

### Agent Lifecycle And Configuration

Verify executable discovery, exact Agent Home selection, new Agent creation,
duplicate request handling, title updates, permission changes, model/reasoning/
speed settings, config override persistence, unsupported-option fallback,
archive, delete, restore, and process cleanup.

Agent and provider identity must remain stable across restart and Chat/Terminal
replacement. Unsupported controls must not appear merely because of a provider
name.

### Structured Chat

Verify connection, prompt, Queue/Steer, cancellation, permissions, forms,
authentication, configuration, attachments, media, tools, patches, plans,
child Sessions, Fork, and failure recovery.

History and live updates must use the same ordered transcript. Checkpoint/delta
gaps must cause replacement, not missing content. Reload must restore the
reader's semantic position without keeping every inactive Chat mounted. An
uncertain Prompt must never be replayed automatically.

### Terminal

Verify native and packaged PTY startup, direct typing, Enter, paste, Chinese and
IME input, scroll stability, clickable URLs and file locations, resize, mouse
modes, full-screen TUIs, multiple viewers, hidden-page resume, Server restart,
host rotation, exit, and renderer failure.

The terminal must show one authoritative screen after recovery. Input arrives
once, and a slow viewer must not block another viewer.

### Projects, Files, Review, And History

Verify Project membership, empty Projects, Git worktrees, ordering, pinning,
search, pagination, Files expansion, deep trees, reload restore, symlinks,
editing, external changes, uncertain mutations, Git History, line changes,
Review revisions, reviewed state, comments, and History resume.

Files remain workspace-owned when Agents appear, reorder, archive, or disappear.
Historical Review evidence must not change when the working tree changes later.
Session disclosure must exercise repeated Show more actions and Show less, not
only the presence of pagination controls.

### Browser, Computer, Extensions, And Desktop

Verify fresh capability reads, Agent Home scoping, Resource ownership,
Browser/Computer isolation, shared human/Agent control, handoff, stop/delete,
reconnect, restart, and uncertain action outcomes. ACP and Terminal must reach
the same capability contract.

Desktop stories use visible controls only: local launch, remote enrollment,
cancel, backend switching, tunnel loss, quit during startup, relaunch, Files,
History, Terminal input, and focus/fullscreen behavior.
Opening an Extension source file must reveal it in Files, and workspace Back/Forward
must restore the prior Plugins tab, Home, kind, detail, and scroll location.

### Usage, Notifications, Mobile, And Accessibility

Verify provider-backed usage data, no-data and failure states, completion
notifications, unread state, keyboard focus restoration, menu dismissal,
accessible names, phone navigation, software-keyboard behavior, refresh, and
remote reconnect. Missing telemetry is omitted or explained; it is not invented.

### Scale And Soak

Exercise many live and historical Agents, including at least one 100+ Session
scenario when the affected subsystem targets that scale. Measure:

- backend and provider process count;
- memory and CPU by backend, browser, and provider runtime;
- Chat and Terminal navigation latency;
- transcript and state wire volume;
- DOM and render work for visible and inactive views;
- reconnect, restart, and cleanup time.

Do not introduce a fixed concurrency ceiling to make a scale test pass. If a
non-Chat/ACP bottleneck is found outside the authorized change scope, record a
design proposal and evidence instead of silently expanding the implementation.

## Real-provider Smoke Rules

Use a minimal prompt or a tiny isolated file change. Confirm login and runtime
availability before starting. Preserve the exact Provider Session identity when
testing resume or Chat/Terminal switching. Record cost-sensitive model choices.

A real-provider gate declares one fixed low-cost model and reasoning level, and
no turn may be billed to anything else. A model it only selects to prove a live
switch must never receive a prompt. Because a launched or resumed provider
session inherits its own configuration, each surface must confirm the declared
model from provider truth, and switch it back through the product path, before
it sends the first prompt. A gate must not depend on the operator's personal
provider configuration for that guarantee.

A missing login or capability may produce a clear blocked result; it must not
fall back to a different Agent, model, permission mode, or runtime without an
explicit product contract.

## Evidence And Report

For each failure record:

- revision, environment, installation form, and isolated Config;
- user-visible steps, expected result, actual result, and last stable state;
- owning lifecycle state and whether the outcome is known or uncertain;
- screenshots or video for visible issues;
- relevant trace and bounded log excerpts;
- cleanup result.

Classify findings by severity and distinguish product defects, test defects,
environment limitations, and improvement proposals. A green test is evidence
for its declared scenario, not proof of the whole product.

## Pass Criteria

- No unresolved P0 or P1 issue.
- Required deterministic checks pass for the affected surfaces.
- Real providers either complete the required smoke or fail with an actionable,
  correctly attributed reason.
- Mobile and remote supervision paths are usable.
- Restart and reconnect do not lose or duplicate accepted work.
- All created resources are cleaned up exactly.
- Every accepted P2+ issue has durable evidence and an owner or follow-up.

## Common Entry Points

Use the smallest relevant checks while iterating, then broaden according to
risk:

```bash
npm run typecheck
npm test
npm run lint
npm run build
npm run test:behavior
npm run test:e2e:playwright
```

`test:behavior:contracts` also validates source-inspection ownership. Product
behavior tests must execute the product path; they must not read production
source and assert private strings. The only permitted source inspections are
small, documented static contracts for architecture, package assembly,
generated output, or security. Existing implementation-text debt is frozen in
`tests/source-inspection-allowlist.json`, which separates the permitted static
allowlist from legacy behavior-test debt. Allowlist entries are limited to
architecture, package assembly, generated output, or security; legacy entries
are not permissions for new tests. Each record has an exact count and owner.
A migration must remove or lower its entry; any baseline change is reviewed.

Purpose-built release or remote smoke commands remain documented beside the
subsystem they validate. Do not add an unimplemented runner proposal to this
runbook; add the command when it exists and is continuously usable.
