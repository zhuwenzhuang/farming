# Codex Runtime Modes

> Chinese version: [codex-runtime.zh_cn.md](./codex-runtime.zh_cn.md)

Codex Chat uses ACP; Codex Terminal uses the native PTY. Generic execution,
configuration, transcript and recovery follow [ACP Runtime](acp-runtime.md),
[Terminal state](terminal-state-protocol.md) and
[Provider Session identity](provider-session-identity.md). This document records
only Codex-specific boundaries.

## Executable And Process Ownership

Chat uses Farming-owned pinned adapter/runtime artifacts for the exact Agent
Home. Existing Sessions retain their recorded launch identity. Terminal uses
its independent executable policy and launches with `--no-daemon` so the entire
owned process tree can be stopped without leaving a shared Codex server.

Native starts sharing one Agent Home serialize until authoritative TUI readiness,
because they share the Home store. The shared Terminal coordinator owns the
queue, deadline and cleanup; the adapter declares the constraint. Different
Homes remain independent.

## Session Continuity

A fresh Terminal has a temporary Farming identity. After user input, History,
recovery, Fork and runtime switching require a proven resumable Provider Session.
When the exact runtime is idle, one bounded `/status` probe may establish identity
from its structured rendered panel. Arbitrary output, model labels and an
unconfirmed write cannot establish identity. Probing preserves unsubmitted drafts
and never automatically repeats uncertain input.

Chat/Terminal switching preserves the proven conversation through real runtime
replacement. Its control remains visible but disabled while identity is unconfirmed.
A stopped unconfirmed Agent remains inspectable without claiming resumability.
The shared ACP contract owns saved configuration restoration and failure rollback.

Releasing a shared Codex Session requires exact `thread/closed` acknowledgement
or explicit `notLoaded`; unsubscribe acceptance alone does not release its writer.
Failure, disconnect or timeout blocks replacement while unrelated Sessions remain live.
The managed app-server does not retain unsubscribed idle threads.

Active-Turn Fork uses the provider's `beforeTurnId` boundary, excluding unfinished
output while leaving the source running. It is unavailable until the provider
has assigned the Turn identity. Child environment and ownership isolation follow
the shared Fork contract.

## Adapter And Native Controls

Capabilities come from the live handshake and Session state, not the Codex name.
Typed media, tool results, diffs, permissions and child activity stay structured.
Native metadata and extensions normalize at the adapter boundary. Standalone tool
results and audio remain inspectable; realtime transcript segments update by item
identity; authentication recovery and strict-review notices remain visible.
Account/project/queue inventories and model configuration are not Agent activity.

The native profile transaction selects exact model, reasoning and speed identities.
It has one ordered-input fence and deadline, and succeeds only after the picker
closes and the requested profile is confirmed in a fresh rendered screen. Open
menus, stale footers and stripped ANSI text are not confirmation. Cancellation
and uncertain input settle without replaying a selection or toggle.

The Composer uses the advertised catalog and reasoning choices, including version
labels and unknown model families; styling cannot filter available models.

## HTML Visualization Boundary

Only a provider-normalized host visualization directive enables the scripted
preview path; an ordinary HTML link does not. Absolute paths refer to files
readable by the backend. Basename references resolve against the originating
Codex Home. Fork/resume retain paths, not copied files or immutable snapshots.

An authenticated owner grants a short-lived, unguessable preview lease for one
canonical UTF-8 HTML file (at most 2 MiB) and its dependency directory. The explicit
resource root must contain the HTML and cannot be the filesystem root. Traversal
and symlink escape fail. Read-only shares cannot create leases.

The resource GET capability works without ambient login credentials and exposes
only that lease's directory. The iframe allows scripts but not same-origin,
forms or top navigation; CSP limits resources to the lease and supported
visualization CDNs, excluding Farming APIs. Direct resource navigation is
script-disabled and sandboxed. Frame messages are source-checked and bounded.

The backend owns lease lifetime; the renderer owns cancellable loading/renewal.
Expiry, restart and failed loads end explicitly. Late results release their lease;
unmount deletes it. Separate views have separate leases. Retry does not replay
Agent work. Resource/script errors stay visible with any usable content.

Authored HTML owns chart layout. Bundled fragment compatibility supplies theme
and common controls; complete documents retain their styling. Appearance changes,
renewal and fullscreen preserve the iframe and interaction state without rerunning
scripts. Measurement remains bounded and works offscreen; transcript scrolling
keeps its existing reading owner. Widget state is local presentation state,
not Agent context; follow-ups use the Composer.

## Acceptance Criteria

Verify exact Home/process ownership, startup serialization, identity probing and
unsubmitted drafts, profile confirmation, Chat/Terminal continuity, writer release,
active-Turn Fork and uncertain-outcome recovery. Visualization acceptance covers
resource isolation, expiry, cancellation, late results and preserved interaction
across Light/Dark/Paper and narrow layouts. Use isolated, low-volume real Codex
smokes for both supported runtime paths.
