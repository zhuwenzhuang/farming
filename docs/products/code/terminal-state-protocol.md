# Terminal State Protocol

> Chinese version: [terminal-state-protocol.zh_cn.md](./terminal-state-protocol.zh_cn.md)

Farming uses one checkpointed persistent-terminal protocol for Farming Code and
Farming CRT.

## Ownership Model

The native PTY host owns the live PTY, ordered byte stream, terminal reducer,
screen state, process identity, and restart continuity. The Farming Server
controls lifecycle and publishes state. Browser renderers attach to that state;
they do not own terminal truth.

One PTY lifetime has one runtime epoch. Within that epoch, ordered output and
state revisions identify an authoritative cut. These values are transport
cursors, not another Agent lifecycle.

## Checkpoint And Delta

A terminal checkpoint contains the runtime epoch, state revision, output
sequence, serialized screen, dimensions, and terminal modes needed to continue
interaction. A browser attach, reconnect, page resume, or detected gap requests
one current checkpoint; it does not poll continuously.

Live output is applied only after the checkpoint installation completes. The
browser discards output already covered by the checkpoint and requests a new
checkpoint after any sequence gap or epoch change.

Checkpoint reads use the negotiated main WebSocket as a multiplexed RPC. The
browser sends `terminal-checkpoint-request` with a request ID and exact Agent
identity; the Server returns the matching `terminal-checkpoint-result` on the
same connection. There is no browser HTTP checkpoint path or compatibility
fallback.

A disconnected request becomes unsent. After the next compatible protocol
hello, the browser may resend that read-only request with the same request ID.
This replay rule applies only to checkpoint reads; it does not make terminal
input or lifecycle mutations replay-safe. Cancellation and timeout remain
bounded, but HTTP connection admission and browser HTTP/1.1 queueing are not
part of terminal attachment. Background attention changes do not speculatively
read checkpoints; an attachment or an actual recovery trigger requests the
authoritative cut it needs.

A stale checkpoint already queued for rendering may drain, but its completion
cannot commit after a newer attachment or recovery generation exists. The
replacement checkpoint remains able to reach a visible authoritative state.

During a full checkpoint install, the previous screen stays hidden. The user
sees either the last proven screen, a bounded recovery status, or the newly
committed screen—never a visible replay of historical redraws.

## Browser Attachment

The terminal session pool owns one browser-side record per Agent. Attachment
identity is the Agent plus its mount. Ordinary component rerenders and callback
changes do not detach a terminal or start recovery.

An attachment lease may enter detached, attached, or release-pending. Reacquiring
the same Agent and mount cancels a pending release. A stale lease cannot release
a newer attachment, and a different Agent or mount releases the old owner before
attaching the new one.

Code and CRT share the same protocol contract and recovery semantics.
Each interface may adapt layout and renderer integration, but must not maintain
a second ordering or checkpoint state machine.

## Input And Resize

Terminal input is the renderer's raw input stream written once to the PTY.
Farming does not add speculative replay or input acknowledgement. Multiple
authorized views may write to the same PTY; the backend serializes writes in
arrival order.

IME composition completes in the terminal input surface before committed text
is sent. Fallback handling must not duplicate ordinary ASCII input.

Touch gesture state belongs to one interaction owner per terminal host. That
owner installs and removes the exact pointer listeners and owns long-press,
momentum, edge feedback, timers, animation frames, and their disposal.

Resize is an ordered terminal transition. Layout churn is coalesced into the
latest complete geometry without violating output order. A browser applying a
committed remote resize does not echo it back. Recovery does not automatically
reclaim an older viewer's geometry when another viewer may be active.

The attachment coordinator remains the owner of protocol generation, operation
revision, state revision, and transition commit. The browser resize-effect
controller owns only observer, fit, redraw, delivery, and local-renderer
effects. Each scheduled effect captures the exact attachment operation and its
own effect revision. At most one resize mutation is in flight, with only the
latest complete pending geometry retained.

A resize delivery timeout is an uncertain mutation outcome. The browser enters
checkpoint recovery and does not send the pending geometry directly. After the
authoritative checkpoint establishes a new attachment cut, the controller may
send the currently visible geometry once when recovery explicitly requires it.
Late acknowledgements, animation frames, or timers from an older attachment or
effect revision cannot complete or mutate the new cut.

## Output, Backpressure, And Rendering

The PTY host publishes output only after the reducer has committed it. Reducer
backlog may pause PTY reads. Slow browser connections are isolated so one viewer
cannot create unbounded debt for other viewers.

Sustained output may be batched for rendering, but every transition remains
ordered and gap-detectable. Resize redraws form a presentation boundary so a
full-screen TUI settles before the browser paints the new cut.

Server-side output-rate accounting uses bounded one-second buckets per Agent.
Each bucket accumulates output bytes and chunk count, and only the current
five-minute estimation window is retained. Usage-rate and attention projections
read those buckets instead of storing and rescanning one object per output
chunk. The estimate may differ by at most one bucket at a time-window boundary;
terminal ordering and byte delivery remain exact and independent of this
diagnostic projection.

xterm.js WebGL is the supported product renderer for Code and CRT. Renderer
failure is explicit; retry reconstructs the same supported path. Diagnostic
renderers do not become silent production fallbacks.

## Clickable Output

Terminal links use layered detection for explicit hyperlinks, HTTP(S) URLs,
workspace file locations, compiler-style locations, and bounded multiline
patterns. Lexical recognition never authorizes a file open: every candidate is
resolved against the captured workspace or an explicit read-only file boundary.
Unresolved candidates remain text.

Detection is bounded by input length, candidate count, and logical-line scope.
File identity and location are preserved without guessing across explicit line
breaks.

Asynchronous link resolution captures the full attachment operation and the
current handler revision. A checkpoint or recovery operation that advances the
same attachment invalidates older resolutions before they can decorate or open
a target.

## Title And Activity Projection

Terminal Agent titles are published through the authenticated Agent control
path, not inferred from terminal prose. Runtime replacement rotates title
authority, user renames remain highest priority, and title failure never blocks
terminal input.

Focused Terminal output and authoritative screen state take priority over
low-frequency activity or preview metadata. Selecting an existing Agent is a
local view change and must not trigger a full Agent-state refresh.

## Recovery And Failure

A compatible Server restart reconnects to the live PTY host. An incompatible
host replacement preserves a final checkpoint before rotation when possible.
Unexpected PTY-host loss is reported as process loss and is never presented as
successful replay.

Transport failures retry with bounded backoff and reach a visible terminal
error after three consecutive failed checkpoint requests. Repeated checkpoint
invariant failure also reaches a visible terminal error instead of looping
forever. A user retry starts a new recovery generation and reads a fresh
authoritative checkpoint. Uncertain input or lifecycle mutations are reconciled
from authoritative terminal and process state and are not replayed blindly.

## Acceptance Criteria

Verification must cover attach, detach, hidden-page resume, reconnect, restart,
epoch changes, sequence gaps, stale checkpoint completion, multiple viewers,
IME, direct input, resize churn, full-screen TUI redraw, mouse modes, clickable
locations, slow connections, renderer failure, and exact process cleanup.
It must also cover selecting an Agent that was initially hidden behind the
collapsed list with at least six Agents while unrelated background HTTP reads
are pending, in both Code and CRT where the interaction exists.
