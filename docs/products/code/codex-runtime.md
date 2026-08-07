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

Plugins configures ACP per exact Codex Agent Home. The default managed choice
uses the release-pinned Codex executable. An explicit custom choice records one
exact executable path as a separate runtime identity. It affects only new Chat
Sessions in that Home; Terminal discovery and existing Session bindings do not
change.

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

## Session Continuity

The provider Session id is the authoritative Codex conversation identity.
Chat/Terminal switching is a real runtime replacement that preserves that
identity only when resumability is proven.

A fresh Terminal may switch before user input has materialized a Provider
conversation. After input, switching, permission restart, recovery, and Fork
require a verified resumable identity. Terminal presentation must not infer that
identity from arbitrary output text.

Configuration follows the shared ACP rule: Provider and Agent Home defaults
apply until the user confirms an explicit override. Confirmed model, reasoning,
speed, and permission choices survive supported runtime replacement; unavailable
saved choices degrade to the current Provider value with a visible warning.

## Failure And Recovery

Adapter or PTY failure must be visible. Farming may recover the same Provider
Session after proving old runtime ownership, but it never replays an uncertain
Prompt or Terminal mutation. If a requested Chat/Terminal switch fails, Farming
restores the original runtime when possible and reports the failure.

## Acceptance Criteria

Verification must cover executable-policy separation, negotiated capabilities,
provider identity, configuration continuity, Chat/Terminal switching, restart,
disconnect, media and tool rendering, live Steer when advertised, and low-volume
real Codex smoke through the supported ACP and native Terminal paths.
