# Agent List State Protocol

> Chinese version: [agent-list-state-protocol.zh_cn.md](./agent-list-state-protocol.zh_cn.md)

The Farming backend owns the authoritative Agent list and its list-level
metadata. Browser interfaces consume that state through a snapshot plus delta
protocol; they do not reconstruct missing state from terminal or Chat traffic.

An initial connection, explicit resynchronization, or recovery from delivery
backpressure receives one logical snapshot through progressive pages. The
default snapshot contains the complete Agent inventory. A client that already
has an exact foreground Agent identity may declare `focused` initial state
interest in its protocol hello; that snapshot contains only the Main Agent and
the exact focused Agent. Its page `total` is the scoped record count, while page
zero separately carries the authoritative global live-Agent and running-Agent
totals. A missing focused target therefore produces a bounded Main-only
snapshot; the client must explicitly widen to `all` and request a new
authoritative snapshot rather than treating absence from the scoped projection
as a complete global result. A legacy client that does not negotiate the hello
within the bounded declaration window falls back to the compatible complete
snapshot. Snapshot completion means that the declared projection is complete;
global Project summaries and inventory totals remain authoritative metadata and
do not imply that a focused client holds every individual Agent record. On
initial load, the first bounded page can render immediately. During recovery,
the client retains its last complete inventory while it assembles the replacement
snapshot, then swaps to the exact authoritative inventory at completion;
following pages carry the same snapshot ID, generation, and sequence and append
at an exact offset. A client accepts list deltas only after the page marked
complete reaches the declared total. A missing, reordered, mismatched, or
interrupted page requests a new authoritative snapshot whose first page
replaces the partial result. Each partial page has a bounded next-page deadline.
The first page also carries authoritative per-Project Agent totals, active and
unread counts, Zombie counts, and maximum attention score for the same snapshot
sequence. Code uses those aggregates only while the individual inventory is
incomplete; after completion, ordinary Agent and live-state updates feed an
incremental per-Project browser summary and remain the authoritative source for
continuously changing row state. During recovery, the new aggregate header may
therefore be shown alongside rows from the previously completed inventory until
the replacement inventory completes; this bounded mixed view preserves
supervision coverage without treating stale rows as the new snapshot.
The Server yields after the first page and pauses later pages while that
client's transport buffer is above the state threshold. From the snapshot cut
until its final page, list deltas and Agent-scoped messages whose projections
can be replaced by snapshot reconciliation share one bounded per-client
post-snapshot queue. This includes `state-delta`, `agent-update`, `agent-read`,
and ACP Session revision messages. The queue drains in original send order
after the final page, and each scoped message rechecks the browser's current
interest before it is sent. Replaceable Activity and Preview updates do not
consume that queue: snapshot completion recovers their latest absolute
checkpoints for the then-current independent scopes. Changing state scope while
pages are in flight abandons the obsolete partial snapshot and starts a new
authoritative snapshot in the requested scope. Queue overflow also abandons the
partial result and sends one compatible single-page authoritative checkpoint,
providing a bounded completion path instead of allowing unbounded memory
growth, repeated progressive restarts, sequence gaps, or a newer hot projection
to be overwritten by an older final page. Later list changes carry complete
summaries only for changed Agents, removed Agent IDs, and changed list-level
metadata. Terminal output and Chat transcript changes remain on their
independent Agent-scoped streams because Agent-list snapshot reconciliation
does not replace those stream reducers.

Browser views declare whether Agent activity is relevant for all Agents, only
the focused Agent, or none. Farming Code keeps all activity while the Projects
sidebar is visible and suspends it in non-Agent views. Farming CRT keeps all
activity on its dashboard and only the focused Agent while a Session is open.
Clients that do not declare a scope retain the compatible `all` behavior.

Agent list updates have an independent per-browser scope:

- `all` sends updates for every Agent. Farming Code and the CRT Dashboard use
  this scope.
- `focused` sends Agent records only for the open CRT Session.

A focused browser still receives every global list sequence. A change to the
focused Agent includes that Agent record. An unrelated change sends an empty
checkpoint plus current list metadata, including the global live-Agent and
running-Agent totals. This preserves exact sequence checks without transporting
unrelated Agent records. `agent-update` and `agent-read` follow the same scope.

Reconnect and sequence-gap recovery keep the current scope. Changing the
focused Agent or returning to `all` requires a new authoritative snapshot.
Agent records intentionally skipped while focused remain hidden and stale until
that `all` snapshot completes. Clients that do not declare an initial scope use
the compatible `all` behavior.

Session previews have an independent compatible `all`, `focused`, or `none`
scope. The scope applies both to live preview broadcasts and to the absolute
preview hydration that follows a complete Agent snapshot. A focused CRT Session
uses `none` because its authoritative live terminal or Chat surface already owns
the visible content; the CRT Dashboard uses `all`. Farming Code uses `focused`
only for its visible Terminal Agent and `none` in Chat or non-Agent views.
After a complete snapshot, a client has a bounded 100 ms window to declare its
Preview scope before hydration. Throughout snapshot delivery and that window,
undeclared live Preview is suppressed. Declaration applies the requested
hydration immediately, while a legacy client that remains undeclared receives
compatible `all` hydration at the deadline. Each complete snapshot owns one
hydration decision; a replacement snapshot or connection close cancels the
previous pending deadline. Widening preview interest or changing a focused
target sends the
current absolute preview checkpoint; when an Agent snapshot is already required
or in progress, its completion performs that hydration instead.
A `none` hydration performs no Agent inventory traversal, while `focused` reads
one exact Agent; only `all` enumerates the complete preview inventory.
A preview without an exact Agent identity is rejected with one bounded Server
diagnostic rather than broadcast without an owner.
Terminal preview text or screen changes remain on that scoped heavy stream.
When a preview-only change alters the derived terminal status, the backend also
publishes one deduplicated `agent-update` containing that status and its resulting
runtime observation. A changed Codex Terminal model, reasoning effort, or service
tier is published through the same lightweight Agent-state path so background
rows do not depend on Preview freshness. A preview that also changes the Agent
title uses the authoritative state delta instead of duplicating that lightweight
update. This keeps Project supervision current when a browser intentionally does
not consume the heavy preview, without adding an update for every preview frame.
The lightweight projection follows Agent-state scope, not Preview scope.
Terminal preview events cannot write runtime observation for an ACP-owned Agent.
The deduplication baseline is refreshed by authoritative Agent-state projections
and structured terminal metadata updates, so alternating sources cannot hide a
later preview-derived transition.

Activity messages are replaceable absolute projections. A slow `focused`
client retains one pending Agent checkpoint marker. A slow `all` client retains
one pending marker and recovers with one compact authoritative activity
snapshot, without replaying individual updates, the complete Agent state, or
Agent previews. Returning from `focused` or `none` to `all` requests that
snapshot only when the connection actually skipped activity.

Adaptive Agent titles publish an Agent-scoped optimistic patch, then join one
pending durability result per Agent. Repeated titles replace the queued value.
Admission requires the Agent's Create intent to have already established its
persisted session record; title updates never create or claim one implicitly.
The durable metadata read, temporary-file write, and `fdatasync` run through
asynchronous filesystem I/O. A generation check prevents that prepared title
from overwriting a concurrent lifecycle metadata commit; on conflict it rereads
the latest record and retries within a bounded budget. Each retry resolves the
canonical provider-session record again and verifies that its runtime owner is
still the requesting Agent. The accepted result is acknowledged only after
atomic publication. Failure rolls the visible title back when that failed
value is still current, and shutdown drains every accepted title operation.

A Fork child inherits the source Agent's current effective row title. The
backend appends `(1)` and selects the lowest positive suffix not already used
by another Agent or an admitted child start, then persists that result as the
child's custom title. Provider title updates therefore cannot silently replace
the inherited Fork identity.

The backend updates the list projection from exact Agent and collection
mutations. Mutations within the broadcast window are coalesced by Agent ID, so
ordinary delta construction is proportional to the changed working set rather
than the complete Agent inventory. Building the complete Agent payload is
reserved for initial and recovery snapshots, which are sent in bounded pages
and replace any possibly missed mutation with current authoritative state. The
first page includes the Main Agent so client startup cannot mistake a later
page for a missing Main runtime.

An Agent row does not wait for optional Git Worktree decoration. Worktree
refreshes run through a bounded background queue, and requests that have not
started yet are replaceable by the newest request for the same exact Agent.
Deletion cancels that Agent's pending refresh; an in-flight result must still
match the same Agent record and refresh generation before it can publish a
list update. Git command timeouts or inspection failure leave the authoritative
Agent lifecycle intact and only omit or clear the optional decoration. This
resource boundary limits background process bursts, not the number of Agents.
Repository-wide Worktree enumeration is reused for a short bounded interval by
the exact normalized Git common directory. Lifecycle postcondition checks use
a fresh read and do not consume a cached enumeration.

Every snapshot and delta identifies the backend generation and an increasing
sequence. A client applies only the next sequence in its current generation.
After a restart, sequence gap, or uncertain delivery, it requests a fresh
authoritative snapshot instead of guessing, replaying mutations, or requiring
per-message acknowledgements.

Farming Code and Farming CRT keep separate presentation state, rendering, and
page-lifecycle policies, but they share the browser-side protocol reducer. Both
interfaces validate canonical Agent-state Server messages at ingress and use the same
snapshot cursor, delta sequence, and Agent-list merge rules. Interface-specific
projection and rendering must remain outside that shared protocol state machine.

Server startup materializes every durable main-page Agent row in one aggregate
state transition before awaiting Terminal-host enumeration, ACP binding, or
transcript loading. Those rows retain their persisted identity, runtime kind,
ordering, and attention cursors. A runtime that has exact recovery evidence is
`pending` or `connecting`; an indexed Terminal without live-host evidence is an
explicit `stopped` placeholder. Runtime recovery then updates existing rows
instead of adding them one at a time. A real user activation of a stopped
provider-backed row sends one exact Session resume mutation; background reads,
preview hydration, and Server readiness never resume it. Opening a Chat row
whose binding is still pending waits on that same authoritative recovery. A
Terminal runtime absent from the authoritative native-host result leaves
`pending` in the same bounded recovery pass and remains visible with an
explicit stopped or failed state rather than disappearing into Provider
history. A missing elected Main Terminal is marked dead and relinquishes Main
identity so the client can create one replacement; it cannot remain a pending
Main placeholder that blocks recovery. If native-host enumeration itself
fails, affected Terminal rows become explicit recovery errors while the elected
Main identity remains reserved; an uncertain live runtime is never replaced by
guessing.

Collapsed Project session pagination is cut before claimed Provider Sessions
are replaced by their live Agent rows. A user resume therefore replaces the
selected Session row in the existing window; it does not backfill another
history row or grow the Project list. Only the explicit Show more control may
expand that window: the initial window is five rows, the first action reveals
up to five more, later actions reveal up to ten more, and Show less resets the
window to five. Hidden counts exclude every Session already represented by
a live Agent, whether that claim falls inside or outside the current window.

Main identity is singular. When legacy records contain more than one
`wantsMain` marker, startup deterministically elects one non-indexed durable
Main and treats indexed provider Sessions as ordinary rows without deleting
or bulk-rewriting history. Main-page membership proves only that a row belongs
in inventory; it does not prove that its Runtime was live before process loss.
Server readiness therefore never auto-resumes every indexed history Session,
and native-host rotation restarts only Terminals backed by an exact serialized
live state from the previous Host. An explicit user resume remains the
authority for a stopped/history Session.

A main-page Provider Session keeps one ordinary conversation-row identity
whether or not a runtime currently claims it. Runtime attachment is internal
state and does not add detached, resuming, or archiving row treatments. Clicking
an unclaimed row sends one exact Resume mutation; when the resulting Agent
claims that Provider Session, it replaces the row backing under the same stable
key. Archive sends one exact Provider Session mutation and removes main-page
membership only after the backend confirms success. Failure retains the row and
uses the existing action-error surface; an uncertain transport result is
reconciled from authoritative state and is never replayed automatically.

Unread state for a Farming-bound Agent is owned by its monotonic attention and
read cursors. The persisted `unread` projection must be rewritten from those
cursors whenever Agent state is persisted; an older contradictory boolean must
not reappear during startup or while a runtime is still pending.

## Follow-up flag

The backend owns the durable `followUp` boolean for each Agent. Farming Code
uses it for the Field Flag marker and per-Project follow-up count. Opening,
reading, completing a Turn, or changing Unread state never clears the flag;
only the explicit Mark or Unmark action changes it.
Archive hides a flagged Agent from the active projection without clearing the
flag, and Restore exposes the same value again. Runtime and permission restarts
preserve the value, while a Fork child starts unflagged.

The flag is a marker, not a second list or navigation mode. Project snapshot
metadata carries an authoritative `followUpCount`; after the complete Agent
inventory arrives, the browser maintains the same count incrementally. Farming
CRT accepts the shared additive Agent field but does not present or mutate this
Farming Code interaction.

## Dynamic pinning projection

Farming Code may project recent or attention-requiring live Agents into the
Pinned section when the locally persisted Dynamic pinning preference is on.
This is a browser presentation projection: it never writes the backend-owned
`pinned` field, changes manual pin order, or promotes Main, archived, deleted,
or history-only Sessions. A live Agent appears in exactly one place. Manual
pins remain first in their existing order; dynamic-only rows follow in stable
Project order, without a separator or a second row treatment.

An unpinned live Agent qualifies while its authoritative runtime observation is
starting, working, or waiting, while it is pending, or while its authoritative
unread projection is true. Otherwise it qualifies for strictly less than one
hour after the newest valid `lastActivity` (falling back to `startedAt`),
attention update, or exit. Opening or viewing an Agent does not count as
activity, and the read cursor is not an activity-time source. Current attention
renders with the existing relative-time label as `now`. When current attention
ends, the same one-hour window starts from the newest authoritative event
timestamp. At the boundary, a dynamic-only row returns to its Project; a manual
pin does not expire.

The Pinned header remains available even when its list is empty. Its bell
button controls only this projection and exposes pressed state; the bell's
unread dot reflects current unread inventory independently of whether dynamic
pinning is enabled. With the preference off, Pinned and Project row behavior
is unchanged. With it on, every full Pinned row exposes the existing relative
activity time even at narrow sidebar widths; row actions still replace that
time on hover or keyboard focus.

Dynamic pinning reuses the page-visible relative-time clock to evaluate the
one-hour boundary. It adds no heartbeat, polling, lease, or persisted per-Agent
timer. Reload recovery reconstructs eligibility from backend Agent state.

Project-level Archive applies only to rows that remain in that Project section.
It protects manually pinned Sessions and Agents as well as live Agents currently
projected into Pinned by Dynamic pinning. Removing a Project is a separate,
confirmed cleanup operation and still releases every associated Agent and
main-page Session, including pinned rows.
