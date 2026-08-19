# Codex Runtime Modes

> Chinese version: [codex-runtime.zh_cn.md](./codex-runtime.zh_cn.md)

Farming exposes two Codex surfaces:

- **Chat** uses the supported ACP runtime.
- **Terminal** runs the Codex CLI in Farming's native PTY host.

The user chooses Chat or Terminal, not a private transport implementation.
Legacy history formats may remain readable, but they are not live runtime paths.

## Executable Ownership

Terminal and ACP are independent executable-ownership boundaries:

- Terminal prefers a usable system Codex executable and selects a verified
  Farming-owned executable only according to the native Terminal version policy.
- ACP uses Farming-owned, version-pinned adapter and runtime artifacts,
  independently of the Terminal selection.

New ACP Chat Sessions use the release-pinned managed executable for their exact
Codex Agent Home; Plugins does not expose a custom executable choice. Terminal
discovery remains independent, and existing Sessions keep their persisted
launch identity, including legacy custom bindings required for exact recovery.

Keeping these policies separate allows native CLI use and deterministic ACP
behavior to evolve without silently changing one another.

## Provider Adapter Boundary

Generic Chat lifecycle, transcript, configuration, permissions, and recovery
belong to the shared ACP runtime. The Codex adapter owns only Codex-specific
launch, executable, capability, and optional-extension behavior.

Capabilities come from the live ACP handshake and Session state. A Codex-only
extension such as live Steer must be versioned and negotiated; the UI cannot
enable it merely because the Agent is named Codex.

Codex structured media, tools, diffs, terminals, permissions, configuration,
and child activity remain typed protocol data. Provider-specific display hints
are normalized at the adapter boundary and must not become generic ACP syntax.

Native Terminal startup ordering is not a Codex lifecycle state machine. The
shared Terminal startup coordinator owns bounded serialization, readiness,
failure, and cleanup. The Codex adapter declares only its stateless constraint:
native starts that share one exact Agent Home serialize until the TUI emits
its readiness signal, because those processes share the Home's local store. Other
providers remain concurrent unless their adapters declare an equivalent
resource constraint.

Provider Terminal Control also owns Codex's delayed Session identity probe and
native model, reasoning, and speed transaction. The generic Agent manager owns
ordered input, runtime fencing, and state publication, but does not identify
Codex or interpret its menus.

## Session Continuity

The provider Session id is the authoritative Codex conversation identity.
Chat/Terminal switching is a real runtime replacement that preserves that
identity only when resumability is proven.

A fresh Chat may expose its connecting shell before the Provider Session id is
materialized. Its transcript projection remains explicitly pending until that
authoritative identity is published; opening, archiving, or replacing the
connecting shell must not turn that expected interval into a failed request.
Loading older transcript pages must preserve the reader's visible position;
prepending history does not itself navigate to the start of the conversation.

A fresh Terminal may switch before user input has materialized a Provider
conversation. After input, switching, permission restart, recovery, and Fork
require a verified resumable identity. Terminal presentation must not infer that
identity from arbitrary output text.

A fresh Codex Terminal therefore starts with a Farming-only temporary identity,
not a guessed resume id. Once the exact runtime is idle, the Codex Terminal
Control performs one bounded `/status` probe through the ordered input path
without marking it as user input. An uncertain write is reconciled from the
rendered status and is never replayed. Only the structured status panel may
confirm the real Session id, and confirmation is fenced to the same Agent and
runtime epoch. Until confirmation succeeds, History lookup, recovery, and Fork
continue to treat the identity as temporary.

Configuration follows the shared ACP rule: Provider and Agent Home defaults
apply until the user confirms an explicit override. Confirmed model, reasoning,
speed, and permission choices survive supported runtime replacement; unavailable
saved choices degrade to the current Provider value with a visible warning.

Codex Chat declares active-Turn Conversation Fork support. The pinned adapter
captures the current Codex Turn id and sends it as the app-server
`beforeTurnId` boundary, so the child excludes the unfinished Turn while the
source continues. Fork remains temporarily unavailable until Codex has assigned
that Turn id.

## Failure And Recovery

Adapter or PTY failure must be visible. Farming may recover the same Provider
Session after proving old runtime ownership, but it never replays an uncertain
Prompt or Terminal mutation. If a requested Chat/Terminal switch fails, Farming
restores the original runtime when possible and reports the failure.

## Acceptance Criteria

Verification must cover executable-policy separation, negotiated capabilities,
provider identity, same-Home native startup serialization, different-Home
concurrency, configuration continuity, Chat/Terminal switching, restart,
disconnect, media and tool rendering, live Steer when advertised, and low-volume
real Codex smoke through the supported ACP and native Terminal paths.
