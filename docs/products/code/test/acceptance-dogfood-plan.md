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

### Browser, Computer, Extensions, And Desktop

Verify fresh capability reads, Agent Home scoping, Resource ownership,
Browser/Computer isolation, shared human/Agent control, handoff, stop/delete,
reconnect, restart, and uncertain action outcomes. ACP and Terminal must reach
the same capability contract.

Desktop stories use visible controls only: local launch, remote enrollment,
cancel, backend switching, tunnel loss, quit during startup, relaunch, Files,
History, Terminal input, and focus/fullscreen behavior.

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
npm run test:e2e:playwright
```

Purpose-built release or remote smoke commands remain documented beside the
subsystem they validate. Do not add an unimplemented runner proposal to this
runbook; add the command when it exists and is continuously usable.
