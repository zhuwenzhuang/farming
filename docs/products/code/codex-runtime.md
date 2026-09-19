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
Codex host-directed HTML visualizations from live or resumed history are
normalized at this boundary. Absolute paths may refer to any HTML file readable
by the Farming backend, independently of workspace, Provider Home or Session.
Basename-only references use the originating Session's actual Codex Home.
The directive retains optional `title`, `mode: "wide"`, and `resourceRoot` fields.
Ordinary HTML links do not opt into script execution.

An authenticated owner creates a bounded preview lease for the canonical HTML
file and its dependency directory (the HTML parent by default). An explicit
resource root may contain the HTML and its dependencies but cannot be the
filesystem root. Relative JS, ES module imports, CSS, fonts, images and JSON
requests resolve within this directory; traversal and symlink escapes fail.
HTML must be UTF-8 and at most 2 MiB. Backend filesystem errors are surfaced;
paths are not transferred between machines or snapshotted for future recovery.
Fork and resume retain paths; the original files must remain readable.

The preview ID is a short-lived, unguessable read capability for this dependency
directory. Only its resource GET endpoint is available without ambient login
credentials, with non-credentialed CORS for opaque-origin frames. Other previews
cannot use this endpoint. Direct navigation to a resource is script-disabled and
sandboxed. Read-only shares cannot create these capabilities. The iframe keeps
`allow-scripts` without `allow-same-origin`, forms or top navigation; its CSP permits
only its dependency URLs and the supported visualization CDNs, not Farming APIs.

The backend owns leases; the mounted renderer owns loading and renewal. Loading
has a deadline and reaches ready or an actionable failure. Retry cancels the old
view; late responses release their leases. Unmount deletes the owned lease;
server restart or lease expiry invalidates resource access with explicit retry.
Separate renders have separate leases. Resource and script failures preserve
available content and expose diagnostics rather than silently showing success.
Browser ResizeObserver delivery deferrals remain console diagnostics, not
resource failures; acceptance must also verify that the layout settles.

Farming supplies a versioned, bundled compatibility layer for visualization
fragments: typography, theme tokens, utility controls, tabs, tooltips and Lucide
icons. Complete HTML documents keep their own styling. Light, Dark and Paper
updates do not rerun scripts. Optional widget state is local presentation state,
not Agent context; follow-up requests must use the composer.

Chart layout remains owned by the authored HTML; Farming does not rewrite chart
markup, axis labels, or panel breakpoints. Normal inline content is capped at
640px; `wide` content may reach 1,024px. This keeps ordinary figures at reading
width while leaving multi-panel layouts an explicit choice. Fullscreen removes
the cap. Compare identical source at identical iframe widths when assessing
host compatibility, since application window widths do not determine chart widths.

The inline surface is unframed and expands to measured content height. Sizing
continues while an entry is offscreen; it cannot depend on animation frames
that browsers may suspend in hidden iframes. A bounded
iframe message channel accepts only size, theme/state and diagnostic messages
from the exact frame. Ordinary charts scroll with the transcript, whose existing
reading-anchor/bottom-follow owner remains authoritative. Very long content has
an explicit full-content expansion, not a nested scrollbar. Wide directives
relax the message width. Native fullscreen keeps the same iframe and interaction
state; platforms without it expand inline. Preview renewal does not reload it.

Acceptance covers multiple Homes and forked paths, dependency imports and JSON,
root escapes, expiry and deletion, load cancellation, complete documents and
fragments, dynamic growth/shrink, persisted interaction during theme/fullscreen
changes, and Light/Dark/Paper at desktop and narrow widths.

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

The native profile transaction supports both the direct model/effort picker and
the quick picker that opens the full catalog through **All models**. It selects
explicit model and reasoning identities, never a quick default or similarly
named model. An open picker is not an idle composer even if the old profile
footer remains visible. Transitions and Escape cleanup share one bounded
deadline; cancellation or uncertain input closes the anticipated picker levels
without replaying a selection. A change succeeds only after the picker closes
and the requested profile is visible. Because visible rows may be only a
scrolling window, multi-digit and off-window targets advance one confirmed
highlight at a time. A complete cursor cycle proves absence; missing or stalled
cursor feedback fails within the same deadline.

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
speed, and permission choices survive supported runtime replacement. An
unrestored saved model remains selected in persistence and blocks Prompt and
Steer with a visible warning until reconnect restores it or the user confirms
another model; Farming must not silently submit using the Provider default.

The Composer model matrix uses the advertised model inventory and its order,
across model generations. Identity styling does not filter the catalog: Astra
uses a blue-white stellar accent, Sol orange, Terra green, Luna violet, and
unrecognized identities use neutral styling. Rows grow with the inventory and
long labels retain their full identity in the accessible cell label. The matrix
uses the reasoning choices supplied by its runtime; Advanced remains available
for the full configuration controls. The Ultra track aligns with the matrix
height; its hit area, knob travel, and energy fill adapt together as rows grow,
in every appearance and viewport.

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
