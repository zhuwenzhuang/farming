# ACP Runtime

> Chinese version: [acp-runtime.zh_cn.md](./acp-runtime.zh_cn.md)

Farming uses Agent Client Protocol for structured Chat with supported coding
agents. The backend owns runtime lifecycle, provider sessions, ordered Chat
state, configuration, permissions, and recovery. Browser interfaces present
that authoritative state and do not reconstruct it from prose or terminal
output.

## Related Sessions and Side Chat

A durable parent Provider Session owns at most one retained Side Chat. Creation
uses the existing owned Fork admission and journal at the provider's stable
conversation boundary. It never cancels, reloads, or switches the parent to
obtain context. Inherited messages are context, not permission to continue the
parent's task; the child acts on new Side Chat messages. Providers without a
verified Fork capability cannot create a Side Chat.

Code places the parent on the left and the selected related conversation on the
right, with independently owned drafts, permissions, and turn controls. Narrow
windows switch between the two views. Collapsing changes presentation only.
Side Chat and native subagent rows remain beneath their owning parent. Native
opaque child identities are fenced by the exact parent runtime generation;
missing transcript capability is reported explicitly.

Idle Side Chats release their runtime after five minutes; loss of explicitly attached owner-client
supervision makes an idle runtime eligible for release after one minute. Accepted
turns, pending approvals/input and native child work continue while the browser is
away; disconnect never forces cancellation. The runtime rechecks idleness at release.
History remains checkpointed and cold recovery does not start a provider.
A new explicit message resumes the same session without replaying a prior
prompt. Stopping the parent releases its exact Side Chat and owned Browser and
Computer resources; an unavailable parent rejects child messages. Uncertain
creation or cleanup stays blocked for authoritative reconciliation.

The [Related Sessions design](related-sessions-design.md) describes the broader
composition and interaction model.

### Reading native related conversations

Native children are observed through their existing parent runtime. The client
negotiates native child events and normalizes their identities and state at the
ACP boundary. Connection-local child IDs remain fenced by the parent runtime
epoch; they are not independently resumable Session identities. Side Chat keeps
its existing durable Fork identity and lifecycle.

Each parent Turn and native child owns its own completion. A parent Prompt
settles after its provider Turn and the already-admitted notification prefix;
background children do not extend that barrier. The session subscription stays
alive across parent Turns. Parent completion or cancellation must not synthesize
terminal child events; only authoritative child evidence settles a child.
Child interruption remains distinct from successful completion in both inventory
and transcript reads.
Session close and process loss retain their existing recovery boundaries.

Related inventory uses a negotiated fresh, bounded read when available, fenced
by parent identity and runtime epoch. Codex explicitly includes subagent sources
when listing descendants. Providers without that read expose only retained
native events. Read failure is visible, never an authoritative empty inventory.

Opening native details reads retained child events or a negotiated, bounded
provider history snapshot through the existing connection. Codex history reads
verify ancestry, page turns and items, and project a private snapshot without
replacing the live reducer. Viewing never starts, loads, resumes, or cancels a
Session. Native controls are unavailable unless separately supported; the parent
continues to own execution. Providers without history-read capability expose
only the child events actually received, with unavailable content reported
explicitly.

Parent Archive first archives all Farming-owned Side Chats, including retained
records after restart, through their existing lifecycle journals. A child failure
blocks parent completion. The Codex adapter fences the parent, freshly enumerates
proven native descendants and archives deepest children first; incomplete inventory,
changing descendants or an unconfirmed child archive cannot report parent success.
Provider-native archive behavior belongs to the adapter; opaque event IDs are never
passed to another provider's history mutation API.

Sidebar child rows reuse the main Agent status indicator, position and appearance tokens.
Native lists show running and attention states by default; finished work is behind
a counted, paged disclosure. An open or selected child remains visible on completion.
Unknown state is labeled explicitly. The shared status vocabulary applies to sidebar and details. Chat owns a chronological activity feed, not an Agent inventory:
only events attributed to that Turn appear, with adjacent repeated progress updates
coalesced and evidence available on demand. Later inventory/status snapshots never
create historical feed entries or rewrite an earlier event's outcome. Started work
and its subsequent completion/failure remain in their original Turn; later ordinary
Turns do not inherit the child list. No finished group, hierarchy or inventory count
is duplicated in Chat. Explicitly opened evidence stays open as new events arrive;
older events remain reachable through a bounded disclosure. Execution and cancellation
remain owned by the backend/provider; feed visibility has no lifecycle side effects.

The related pane reads fixed-size pages using provider cursors (retained-event IDs
for event-only providers). Older/newer navigation and Return to latest keep every
available turn reachable without growing each response. Live updates refresh only
the latest page. Missing cursors, unavailable history and stale epochs are explicit.
Quoting a child's result appends its source and selected text to the parent's draft,
reveals that draft, and never sends it or overwrites existing text.

The related pane serializes refreshes and rejects stale parent identities.
Selecting the same parent row preserves its open related pane. The child row,
activity, and pane header share the child's identity icon; activity summaries
render inline Markdown without introducing interactive links or block layouts.
Closing it cancels the browser read, not the Agent. Read timeout, missing history,
identity change, and size limits terminate visibly. Acceptance covers concurrent
readers, unrelated-thread rejection, live output while viewing, and desktop and
compact layouts in all appearances.

Native details reuse the ordinary Chat turn renderer: task messages, collapsible
process activity, tool results, and Markdown answers retain their shared visual
roles. The pane must not wrap a conversation in a muted summary card, repeat its
title, or count progress messages as tool actions. Read-only presentation does
not mean disabled-looking content; execution controls remain capability-bound.
Sidebar child rows and collaboration cards share the same session-derived icon
and theme color. Sidebar child labels use a fixed hierarchy inset; icons occupy
the indentation gutter without moving labels or subsequent rows. Both remain
inside the selection surface. Finished grouping does not change a child's
hierarchy or label position. Child states appear on their own rows; the sidebar
has no aggregate status row.

## Provider Boundary

Provider-specific executable discovery, environment, adapter patches, optional
methods, and history behavior belong in Provider Adapters. Generic lifecycle and
Chat code use negotiated ACP capabilities and must not infer support from a
provider name.

The stable provider catalog and adapters are also the source of truth for
launch metadata, runtime switching, Terminal input behavior, and
session/inventory policy. Browser and CRT surfaces consume projected
capabilities from that boundary; they must not maintain provider-name
allowlists or duplicate provider defaults.

Provider launch and recovery profiles are projected through adapter policy.
Permission keys, model and reasoning fields, resume-time inheritance, display
names, and retired request aliases are Provider concerns; generic Agent
lifecycle code consumes their normalized result and does not branch on a
Provider name.

Provider History mutations use the same boundary. Archive and pre-resume or
pre-Fork unarchive support are declared and executed by the Provider History
Mutation registry; generic resume, Fork, recovery, and archive flows pass the
exact Provider identity and do not call a Provider-specific command directly.
Archiving a detached History-backed row commits main-page membership removal
only after the supported Provider mutation succeeds; failure leaves membership
unchanged so the same row remains actionable.
Archive and the complete non-Fork Resume admission serialize on the same exact
Provider Session identity. Resume holds that admission from its authoritative
lookup and optional unarchive until the new Agent establishes its claim; the
unarchive step executes inside the owned admission rather than re-entering the
same mutation coordinator.

A live ACP Session may advertise the versioned `_session/archive` extension.
Archive then cancels its active Turn and asks the owning Provider connection to
archive before releasing the local binding. The first submitted prompt makes a
Session eligible for this path even before its Turn completes; an empty,
never-submitted Session needs no History mutation. Success closes that Session
and skips the detached History mutation; failure or timeout keeps Archive blocked
without replaying it through another process. The same exact Session admission
excludes concurrent lifecycle mutations, and unrelated Sessions in a shared
runtime remain live. Explicit retry and restart recovery read Provider History
first so an already committed archive is not replayed. Providers without this
capability retain their existing History mutation contract. In particular, Codex unsubscribe is not proof of
writer release: its idle retention can outlive the close response.

Performance, correctness, reliability, recovery, isolation, and observability
are provider-neutral ACP requirements. A cross-cutting improvement is complete
only when every supported provider satisfies the same adapter contract and
equivalent acceptance criteria. Provider-specific integration may implement
that contract differently, but must not bypass it or be presented as a general
ACP optimization.

ACP and native Terminal have independent executable policies. ACP uses
Farming-owned, version-pinned runtime artifacts; Terminal follows the native
Terminal policy. Updating an ACP pin requires protocol, integrity, recovery,
and Chat/Terminal compatibility verification.

Native Terminal executable discovery returns one normalized compatibility
result. Provider-specific resume-version requirements and trusted test
overrides live in the executable discovery registry; Agent lifecycle code does
not select a Provider-specific resolver.

The default ACP launch is an immutable Farming-managed image that binds the
adapter version, provider CLI version, protocol/build identity, patches, and
the Node or compatibility-loader invocation. New Chat Sessions always use this
managed runtime; Plugins does not expose a second executable-selection path.
Existing Sessions retain the exact launch identity they were created with so
legacy custom bindings can recover without being silently rebound. Environment
variables are compatibility inputs, not the ordinary user configuration authority.
Loading settings removes the retired Agent Home-level custom-runtime selection;
it does not delete an executable still referenced by an existing Session's
persisted launch identity.
An existing Session without its exact recorded executable fails closed during
recovery and is never rediscovered against the current machine.
A Terminal Session has no ACP executable selection. Switching that same
Provider Session into Chat selects the managed ACP runtime for its exact Agent
Home and persists that launch identity before launch; later ACP recovery then
uses only the persisted executable.

Pi uses the ACP Registry-listed adapter as a Farming-owned, version- and
integrity-pinned artifact. The adapter launches the exact discovered system Pi
executable after verifying the adapter's Pi 0.80.4 minimum, and that absolute
executable identity is persisted independently. Farming
patches adapter state into the selected Agent Home under an exact Config and
Agent namespace and injects the shared bootstrap explicitly; it never uses the
adapter's upstream global state path.
Each Pi Chat owns a private ACP adapter process because `pi-acp` supports only
one live Pi subprocess per connection. Adapter version 0.0.33 does not forward
ACP MCP servers or delegate client filesystem and terminal operations, and it
does not advertise permission or fork capabilities. These omissions remain
visible capability boundaries rather than inferred support. Farming maps Pi's
authoritative session statistics to ACP usage updates after each settled turn,
so Chat context usage and cost use the live Pi session values. Pi session history
can index the default directory or an absolute configured directory. A relative
`settings.json` `sessionDir` is interpreted by Pi against its launch working
directory, so Farming does not guess that directory. Configure an absolute
`sessionDir` in the selected Pi Agent Home when Farming must inventory it.

Farming may support standard ACP session, prompt, cancellation, configuration,
authentication, elicitation, terminal, media, plan, and fork capabilities when
the live Agent advertises them. Provider extensions must be versioned,
negotiated, and confined to the adapter boundary.

Qwen Code's version 1 prompt-suggestion notification is normalized at that
boundary into ephemeral, provider-neutral Composer state. It can replace the
empty follow-up placeholder and be copied into the draft with Tab, but it is
not a transcript entry or a durable checkpoint field. A new Prompt invalidates
the previous suggestion, and providers that do not emit the extension retain
the ordinary placeholder.

## Runtime Ownership

Each Config instance has one ACP Runtime Host. The Farming Server is a
replaceable controller; the Host owns live provider connections, active
operations, ordered reducers, and process identities. A compatible Server
restart reconnects to the Host and restores its authoritative checkpoint and
deltas instead of restarting healthy sessions.

Host-to-Controller callbacks remain pending after their message is accepted by
the transport, including when the socket reports backpressure. Only the matching
Controller result completes the callback; disconnect or the bounded callback
timeout ends it with an uncertain outcome. Queue and payload limits still reject
messages that cannot be accepted, without replaying a possibly delivered callback.

Serialization failures leave no pending request or deadline and do not invalidate
a healthy connection. A Controller submits one handler outcome; a missing result
acknowledgment neither retransmits that outcome nor poisons unrelated operations.
A Controller identity or generation change, including on the same connection,
invalidates its previous callbacks and fork reservations. A callback for the
current Controller but a stale Agent binding fails explicitly with an uncertain
outcome without invoking the handler.
Connection replacement rejects the old connection's pending requests and resets
framing. Data and terminal events from a detached socket cannot affect its
replacement; invalid responses close the affected transport.

That Server-only reconnection is failure-recovery behavior, not an intentional
Farming stop mode. Farming has one intentional stop semantic: directly kill the
complete selected set of Farming-owned processes, without graceful shutdown or
drain, handoff, or process preservation and reuse. This single hard-stop
contract deliberately simplifies state management and is required for
state-machine correctness: a graceful path would add a second termination
scenario and can hide failures exposed by abrupt loss. Recovery and cleanup
must therefore be correct against hard stop. The repository's `npm restart`
command performs a full Farming stop followed by a fresh start; its performance
work must optimize cold inventory and Session recovery.
On Linux, exit verification treats a process group containing only exited
zombie entries as stopped, while any runnable, sleeping, or stopped descendant
continues to block cleanup.

A full restart must include the ACP Runtime Host and every Provider process in
the selected process set. If a reachable Host remains despite that stop, the
fresh Server replaces it even when its protocol and build identity are
compatible; full restart must never attach an old Host generation. An ordinary
Server-only restart continues to attach a compatible Host and preserve its live
Sessions.

ACP has no fixed Agent, Session, process, thread, or concurrency cap. Resource
protection must come from bounded queues, payloads, caches, and backpressure,
not from an arbitrary limit on how many Agents may exist.

Provider runtimes may be shared only when the provider supports independent
multi-Session operation. Following the External Agent connection boundary used
by Zed, a shared pool is scoped to one canonical Project and keyed by Provider,
canonical Agent Home, and adapter launch identity. Every Session still owns its
own workspace, provider Session id, configuration, permissions, identity, MCP
scope, active Turn, and recovery state. Within one Runtime Host, a Provider
Session has at most one live owner across all Project pools. Closing or deleting
one Session must not stop unrelated Sessions in the same pool. A pooled runtime
failure reconciles every affected Session and never replays an uncertain Prompt.
After the Session enters `connecting` and before Farming acquires a Provider
process, it creates the selected Agent Home when missing and resolves its
canonical identity. A Home preparation failure becomes an explicit Session
failure and never falls back to another Home or executable.
Codex, Claude, OpenCode, Qoder, Qwen, and Pi use this connection boundary. As in
Zed, Session release sends `session/close` only when the Provider advertises
that capability; otherwise Farming releases its local Session reference and the
Project connection reclaims the Provider process when its final Session ends.

Browser and Computer capabilities use the instance-exact Farming CLI and
shared backend services rather than one capability subprocess per Agent.
Each ACP Session receives its Agent and Project identity through Session-scoped
environment metadata. CLI calls carry that local identity, and the backend
resolves the current Agent and Project workspace directly. Identity and other
Farming operational context must never be appended to a user Prompt. The name
is routing state, not a separate authorization credential. Farming-owned
capability MCP entries are not injected into ACP Sessions; provider and user
MCP configuration remains a private Session input.

Farming's bootstrap contains provider-neutral operational instructions. It does
not define the user's preferred response language, and punctuation-only or
otherwise language-neutral input must not derive a language from bootstrap,
UI locale, Agent identity, workspace metadata, or hidden operational context.

## Session Identity And Configuration

The stable identity of an ACP conversation combines Provider, canonical Agent
Home, provider Session id, and workspace scope. Additional directories and MCP
definitions are private Session inputs and must survive reconnect, restart, and
runtime replacement without being exposed as ordinary browser state.

Provider adapters declare whether a Provider Session id is scoped to one Agent
Home or globally within that Provider. For a global Provider identity, the
persistence layer rejects binding the same Session id to a second Agent Home;
generic storage does not identify such Providers by name.

A Session plan marked temporary is not a confirmed Provider identity and is
never resolved through Provider History. This applies uniformly to every
Provider until its adapter-specific identity evidence is confirmed.

Configuration has two authorities:

- without an explicit user override, the loaded Provider Session and selected
  Agent Home supply defaults;
- after a user change is confirmed, Farming persists only that explicit
  override and reapplies it after the Provider Session is loaded.

Composer model, reasoning, and Fast choices also update the selected Agent Home's
new-Agent defaults in the current Farming Config instance. The backend owns this
transition: a confirmed configuration mutation, or a durably accepted change
queued during a turn, saves only the requested fields (including Fast off). A
confirmed model change also saves its effective reasoning level. Failed or
uncertain mutations do not update defaults. Saving requires the same Provider,
Home ID, and Home path; a removed or rebound Home is rejected. Configuration
writes merge against the latest Home state; the last accepted write for each
field wins. A save failure reports that the Session accepted the choice but its
defaults were not saved, without replaying the Session mutation.

Fresh Agents inherit these defaults through the Provider's advertised controls
and checkpoint the effective choices as their own Session configuration.
Existing Sessions, reconnect, resume, and fork retain their own configuration;
restoration never writes Home defaults. Native Provider configuration remains
unchanged. Saving or reordering Agent Homes preserves their new-Agent defaults.

Overrides are matched by stable option identity, never by display labels. A
model missing from the advertised catalog is not proof of removal: the Provider
may have returned a fallback catalog after a failed refresh. Farming preserves
the saved model and reports a recovery warning. Until restoration succeeds or
the user explicitly selects another model, Prompt and Steer reject before
Provider submission; history, configuration, and reconnect remain available.
Reconnect reapplies the saved choice against the new catalog. A confirmed model
change and clearing its recovery warning belong to the same ordered mutation,
so a waiting Prompt sees the confirmed selection.
During reconnect's process replacement gap, Controller callbacks remain fenced
to the Host's last published binding until the replacement publishes its epoch.

For other unsupported options or values, Farming keeps the Provider's current
value, drops only the incompatible override, and reports a recovery warning.
A transport failure is not proof that an override is permanently incompatible.

## Turn And Mutation Semantics

One Session admits conflicting Prompt, Steer, Cancel, configuration, and child
control operations in a defined order. Each operation is fenced to the current
binding and Turn. Late results from a replaced binding cannot change current
state.

Prompt submission has an explicit identity. Duplicate submission of the same
request may join the existing result, but a request with different content is
rejected. When transport failure leaves Provider ownership uncertain, Farming
does not replay the Prompt or Steer automatically. Cancellation targets the
exact active Turn and reaches a visible terminal result.
Composer admission uses one deadline across control-queue waits, checkpoint
writes, and the final Provider send. Expiry before that send rejects the message
without dispatching it.

The Composer's temporary Prompt-start guard ends when authoritative activity or
a newer Session revision confirms the transition. Completion may arrive before
the submission acknowledgement; a late acknowledgement must not restore a busy
Composer after that completed Turn. Rendering observes this ordering directly,
without waiting for local guard cleanup or another runtime event.

Queued follow-ups remain editable and discardable until admission begins.
Negotiated live Steer remains inside its owning Turn; providers without that
capability use the visible queue.

Chat owns two viewing states: following the latest content and reading history.
An accepted Composer Prompt or Steer for the visible Agent resumes following,
clears pending reading-position restoration, and reveals the latest content as
the transcript arrives. Rejected or uncertain submissions and queued messages
awaiting admission do not change this state. Ordinary transcript updates preserve
history reading; a new user scroll can pause following again. Hidden Agents do
not replay a send's scroll request when reopened. This contract is shared by all
ACP providers and does not retry or otherwise change message delivery.
Returning to latest clears history navigation intent. Scroll events caused by
that action or by viewport resizing cannot load an older page; history paging
requires a user scroll gesture, including on a latest page shorter than the viewport.

Farming negotiates standard Steering from the Agent's initialize response and
uses `_session/steering` only while it owns an active Turn. The older Codex
steer extension remains an adapter-boundary compatibility path for Agents that
do not advertise the standard capability. Accepted Steering is recorded with
provider-neutral Farming metadata so every supporting Agent has the same
transcript and Composer behavior.

Static `supportsSteer` advertises protocol support; dynamic `canSteer` reports
whether the backend still owns a running, unsettled Turn. Native completion
immediately disables steering while the ACP response settles. The Composer
queues follow-ups during that interval and never replays an uncertain mutation.
A definitive admission rejection includes its reason in the first terminal
status, so a later result is not needed to explain a preserved draft.

The Composer's Goal input is intentionally prompt content, not a persistent ACP
Goal binding. Farming does not create cross-Turn Goal state from that input;
the submitted text remains the complete source of truth.

## Transcript Protocol

### State and synchronization invariants

Runtime state, Turn outcome, and request ownership are separate facts. The ACP
Runtime owns execution and Turn transitions; Host operation records own request
identity and settlement barriers. A pending request never overrides an observed
permission wait or Runtime failure. Only proven binding loss interrupts a
persisted active Turn; compatible reconnection preserves the live Turn. Failure
is a structured outcome even when the Provider supplies no explanatory text.

A transcript read names its Agent, Session, epoch, revision, and covered range.
The latest revision belongs to the live tail. An older page cannot advance it
or apply the Session's current activity or stop reason to a historical Turn.
Entry patches describe a contiguous range plus an optional owning-prompt anchor;
the anchor alone does not establish overlap. History and live reads share one
serialized scheduler, but the pagination cursor belongs to the individual read.
An identity change fences all older responses. A reset invalidates cached
history; ordinary updates replace only the declared range.

The browser retains one contiguous window with a 2,048 Entry budget (including
an optional prompt anchor). Live reads
evict from the oldest end; older-page reads evict from the newest end and retain
an explicit historical window with Return to latest. Live notifications and
reconnect do not move that historical reading position. A partial historical
Turn does not imply a missing final reply. A gap cannot be silently joined. Runtime control state continues to update while history is being read.
A historical window is a frozen reading cache of pages from their respective
read times, not one atomic snapshot. Its retained revision is only the last
confirmed live revision and cannot serve as a delta baseline after the tail is
evicted. Return to latest always reads a checkpoint.
Queueing expires after 30 seconds and reads after 15 seconds; retries are finite and end in a visible read
error. Only fresh evidence or explicit Retry starts another attempt.

Acceptance compares incremental state with an independent authoritative snapshot
for the same identity, revision, and covered range after live reconciliation
(or same-version historical reads). Mixed-version historical pages instead
require identity, cursor continuity, preserved content, and no inferred live status. It also
checks stale-response exclusion, historical-page isolation, bounded storage and
bounded failure under completion, cancellation, reconnect, and restart ordering.
Successful catch-up assumes available transport and scheduling; permanent failure
must still terminate the read visibly instead of claiming synchronization.

The browser bounds a Chat history read to 15 seconds. One timed-out read may
retry because it is read-only; a second timeout reaches a visible error and
explicit Retry. Reconnect and fresh revision signals still trigger their own
authoritative reads without replaying a mutation.

Transcript entry identity belongs to the reducer and is distinct from a provider
message ID. A provider message can resume after an intervening Steer or tool
entry; each noncontiguous segment keeps its position and a unique entry ID.
Adjacent chunks retain their existing merge semantics. Checkpoint recovery
repairs legacy duplicate message-segment IDs without dropping content, advances
the revision, and requires a replacement checkpoint before further deltas.


The backend reduces history replay and live ACP updates into one ordered,
provider-neutral transcript. Typed text, reasoning, tools, patches, plans,
terminals, media, resources, permissions, and child Sessions remain structured;
the UI must not flatten them into prose and parse them back.

Browser delivery uses a strict checkpoint-and-delta contract:

- a checkpoint identifies the exact Agent, provider Session, runtime epoch, and
  transcript revision;
- a delta applies only to the same epoch and exact preceding revision;
- any gap, identity change, or reset requires a replacement checkpoint;
- a late response for another Agent or older revision cannot take over the
  visible Chat.

The ACP Session read endpoint returns control metadata without transcript
Entries by default. A caller that intentionally needs the raw, potentially
large Entry collection must opt in with `includeEntries=1`; product interfaces
use the bounded transcript APIs for conversation content.

Each browser connection explicitly identifies its currently visible Agent and
the bounded set of retained ACP Chats whose structured transcripts it owns.
ACP revision notifications are delivered only to connections with matching
interest. Changing focus, adding retained interest, or reconnecting sends the
current absolute cursor—Agent, provider Session, runtime epoch, and transcript
revision—as an Agent-scoped checkpoint. A Session or epoch replacement is
delivered even when its revision restarts at a lower number. A slow connection
retains only one pending checkpoint marker per interested Agent and recovers
the latest revision after its transport buffer drains; it never accumulates one
queued notification per Provider update.

An HTTP transcript read samples the authoritative Session and runtime epoch
before and after the cross-process read and rejects a response if that identity
changed or the returned transcript names another Session. Transcript revision
may advance during the read; continuously progressing Agents do not wait for a
quiet revision before returning a self-consistent result.

The Runtime Host projects transcript pages before they cross the Host response
boundary. Large tool payloads become bounded summaries and inline media becomes
an on-demand reference while the Host retains the exact entry. Response-size
enforcement therefore applies to the browser-facing projection, not to an
unprojected Provider payload that the Server has not yet had a chance to bound.
The projection carries an explicit version and participates in the Runtime Host
build identity, so a Server cannot silently attach to a Host with different
projection semantics.

On-demand reads preserve the same boundary. Media is selected and validated in
the Host, then transferred in bounded chunks; tool detail and review changes are
derived in the Host and transferred in bounded pages. The Server fences every
multi-page read by Session and Runtime epoch before assembling the existing HTTP
response. Subagent media uses a Session-scoped route so an Entry identity cannot
resolve against the wrong transcript. A raw transcript Entry is never the
cross-process payload for these browser APIs.

Provider replay is authoritative. Local checkpoints accelerate projection and
preserve reset fences, but cannot replace a full load unless the provider can
prove freshness. An uncertain Prompt leaves the checkpoint dirty.

The Host checkpoint store owns the durable dirty fence. Prompt admission waits
for its first successful durable write, then reuses that proof across inexact
snapshots. Scheduling an exact rewrite invalidates the proof before enqueueing;
subsequent admissions establish a new fence after that rewrite. Failed fence
writes never establish proof. Process restart discards all in-memory proofs.
Background snapshots coalesce to one latest pending state per Session while a
write is active; they must not form an unbounded queue ahead of Prompt admission.
Explicit writes and flushes retain their ordered completion semantics.

The ordered Session reducer remains provider-neutral. Transcript details that
are not part of standard ACP—such as internal-context scoping, compaction-text
recognition, message-phase boundaries, and duplicate-message reconciliation—
belong to a selected Provider transcript policy. A Provider must not inherit
another Provider's text heuristics merely because its visible output happens to
match the same prose.

Opening a Chat should show its shell immediately and obtain the first settled
transcript in tens of milliseconds when a valid prepared checkpoint exists.
Preparation happens in the backend only after an explicit interest signal and
a quiet period. It is cancellable, revision-fenced, and bounded by entry count,
response size, total cache size, and active work. Failure or eviction falls back
to the same authoritative on-demand read.

Prepared and in-flight projections are fenced by the complete projection
identity: Agent, provider Session, runtime epoch, Session revision, and
projection revision. A runtime-only or replay correction invalidates older work
even when the Transcript revision is unchanged. The browser may reuse a
completed Turn object only when its complete structured projection is unchanged;
an authoritative correction to any nested Tool, Media, Resource, or other field
must replace the visible Turn.

The first settled ACP transcript response contains only the five newest Turns.
Older Turns load in bounded pages as the reader moves upward, so opening a long
Chat does not make its full Markdown and tool history part of first paint.

The browser keeps a bounded LRU of complete structured transcript records for
recent Chats, including any older Turn range the reader loaded. Retained records
continue to merge live revisions while inactive; revisions coalesce to one
latest high-water per Agent, reads are single-flight per Agent, and background
read cadence plus global read concurrency are bounded. Only the visible Chat
owns the React, Markdown, and tool-card DOM. Reattaching a retained record whose
observed Session and runtime epoch still match shows it immediately and
continues from its revision without requesting a checkpoint solely because it
became visible. An unfinished retained Turn is revalidated on reattachment so
a missed completion notification cannot leave it appearing to run indefinitely.
A cold or evicted Chat, reconnect, identity change, detected
gap, reset, or pagination-range change still requires an authoritative
checkpoint before replacement content becomes visible. Reading position is
anchored to a stable Turn or process item rather than raw pixels, and transcript
records share the same 20-view working-set boundary as pooled Terminals.
An older-history cursor belongs to one page read; after that read settles, live
revision notifications must again fetch the newest Turn without a page cursor.
An older page never advances the latest-Turn revision, even when the page
response carries a newer Session revision.

ACP Session controls use the same Agent-scoped working-set ownership. The
browser retains each recent Agent's last confirmed mode, model, reasoning,
permission, and account snapshot rather than clearing it when another Chat
becomes visible. Reattaching shows that confirmed snapshot synchronously while
a fresh authoritative Session read revalidates it. Retained controls remain
visible but are not actionable until that read confirms the current Agent and
runtime revision. A failed revalidation surfaces an error, preserves the last
confirmed presentation, and keeps its controls disabled; a never-loaded or
evicted Agent still waits for its first authoritative snapshot. Refresh and
mutation responses remain fenced by exact Agent identity and request sequence,
and archiving or working-set eviction discards only that Agent's retained
snapshot.

Provider-wide discovery belongs to the shared ACP runtime, not to an individual
Session. Concurrent Session opens for the same provider Home and Project must
coalesce Skills and model discovery. A completed discovery result is not an
authoritative cache for a later Session open: later opens force a fresh Skills
read and obtain a fresh model inventory. Authentication or provider-routing
changes advance the discovery generation, so an older in-flight model result
is re-read before use. Failed discovery is never cached. Session-owned history
restore remains authoritative and may still take time, but concurrent opens
must not serialize behind duplicate runtime-wide discovery work.

## Lifecycle And Recovery

History transport must process fragmented messages in linear time, preserving
UTF-8 across chunk boundaries and joining a complete JSON message only once.
Turn-count pagination does not bound response bytes: one history page can contain
tens of megabytes of tool output. Acceptance includes such a fragmented page
within the existing Session setup deadline, without dropping history or raising
that deadline to conceal transport overhead.

The meaningful Session states are connecting, idle, working, waiting for user
input, interrupting, recoverable error, and terminal failure. Idle is an
ordinary live state. A Session remains live until the user archives it, the
system replaces or cleans it up, or an exact runtime failure is proven.

Unexpected adapter or Host loss ends in explicit recovery or failure. Recovery
must prove old-process ownership, restore the same Provider Session and private
scope, reload authoritative history, and preserve explicit configuration
overrides. A Turn active at disconnect ends as failed or uncertain and is never
silently replayed.
Recovery and reconnection are not Agent activity and must not advance the
persisted last-activity time. That time advances only for real runtime work or
human-attention events; a recovery failure timestamp is lifecycle evidence, not
activity.
If a reconnected or replacement Host no longer owns a previously observed
binding, Farming marks that binding interrupted and immediately schedules cold
recovery of the exact persisted Provider Session. The transient interruption
must not become the Session's terminal state when cold recovery succeeds.

An ordinary startup does not replace an incompatible Host that owns live Chat
Sessions. An explicit full restart may intentionally take over that Host,
terminate its live Sessions, and start a new Host from the persisted Session
records.

Cold recovery materializes the complete recoverable Agent inventory before it
loads Provider Sessions. Session preparation then runs with bounded parallelism
in persisted priority order; one Session failure does not stop the remaining
work. When multiple records refer to the same persisted process identity,
Farming performs one exact hard-stop proof for that identity and shares its
result across those records. Parallel completion must not reorder existing
main-page membership.

Failure to start or reconnect the ACP Runtime Host marks affected Chat Sessions
unavailable without blocking Server readiness, native Terminal recovery, Files,
or Plugins. Recovery of one runtime family cannot become a global lifecycle
barrier for unrelated runtime families.

Chat/Terminal switching is a real runtime replacement that preserves the same
provider conversation when resumability is proven. Switching is rejected while
a Turn is active. If the target runtime fails to start, Farming restores the
original runtime and reports the failed switch.

Conversation Fork is available only when the adapter contract and live
capability both support it. The source revision, child identity, ownership, and
cleanup responsibility must be exact. Failure before the child is durable is
visible and must not silently create a different fork.

An active Turn remains a Fork barrier unless the Provider's adapter contract
explicitly declares active-Turn Fork support. Such a Fork must use a
Provider-owned stable boundary before the active Turn, leave the source Turn
running, and avoid copying partial assistant or tool state. A moving transcript
revision does not invalidate that stable boundary; Providers without this
declaration retain the ordinary idle-only rule.

Fork child launch has one settlement rule across runtime strategies: the first
callback or Promise result is authoritative. A callback failure or resolved
null is definitive and permits exact cleanup. A synchronous throw or rejected
Promise is uncertain; Farming retains the exact forked Provider Session and
does not delete or replay it before durable reconciliation.

When Farming restarts while a Fork operation is still non-terminal, recovery
converges it before any runtime starts. With an exact source runtime Agent
identity the operation is transitioned to durable blocked; if that blocked
transition cannot be persisted, the journal keeps the original pending truth
and the source still recovers fail closed as lifecycle-blocked. Without an
exact identity nothing is guessed or transitioned: the operation stays pending
with an explicit warning. In every case the Fork is never replayed
automatically, the same request may only reconcile against the durable
outcome, and archive or delete supersedes it while the source is addressable.

### Fork History Boundary

A fork's origin is a durable conversation boundary owned by the child runtime,
not a banner at the start or moving end of its transcript. After the provider
has prepared the child history and before the child accepts input, capture its
inherited user-turn prefix and persist the origin in its checkpoint. A fork of
a fork captures a new boundary for its immediate source.

The divider follows the last inherited visible Turn and precedes all child
Turns. A newly opened fork reveals that boundary with the inherited tail; later
messages, pagination, refresh and parent activity never move it. Empty inherited
history places it before the first child Turn. It is presentation metadata,
never a user/assistant message sent to the provider.

Recovery loads history authoritatively and verifies the saved ordered user
prefix before rebinding the boundary to replayed entry identities. Tool replay
shape and regenerated IDs must not move it. Missing or incompatible history,
including compaction that removes the prefix, exposes an unavailable boundary
instead of guessing. Legacy forks without a saved boundary show origin-only
information with that limitation; merely opening one must not mark its current
tail as inherited. Paging past the boundary hides the divider until its Turn is
loaded, rather than relocating it into the visible page.

Acceptance covers initial tail visibility in every appearance, first child
submission, checkpoint/replay recovery, pagination, repeated forks, empty
history and unavailable boundaries across provider adapters.

## Presentation Contract

Compact Chat keeps the current Plan collapsed to one summary row above the
Composer in normal layout flow. Expanded details scroll within a bounded height;
neither state overlays the title, transcript, or input. Agent changes close the
disclosure. Mobile titles retain the shared bounded row title and let available
width determine visual truncation instead of applying a short character limit.

Local image Resource links use the same bounded inline preview and accessible
enlargement as both Markdown image syntax (`![alt](path)`) and image file links
(`[label](path)`), including relative, absolute, and exact external paths. Local
image sources resolve through the file endpoint, never as website routes. The existing
authorized file endpoint owns access; a missing MIME type does not suppress a
recognized image path. Failed image loads remain visible as unavailable evidence.
Ordinary Resource labels truncate within their row without widening Chat or
displacing subsequent image attachments and Steer messages.

Chat shows the ordered conversation, one compact live activity signal for the
current Turn, and reversible structured evidence. Completed reasoning and tool
details do not remain as overlapping default summaries. Disclosure controls
keep stable layout slots and become visually prominent on hover or keyboard
focus. Intermediate Tool failures remain available within their action groups
without replacing those groups' action-oriented summaries; authoritative Turn
and Runtime failures remain visible at the higher level.
When a non-active Turn has structured process evidence but neither a final
assistant result nor a stronger explicit interrupted state, its process ends
with one lightweight line stating that no final reply was produced. This state
is projected from the transcript and survives reload; it adds no recovery
action or separate notification surface.

Historical patch cards retain their structured diff evidence after the files
are committed. Their Commit follow-up is visible only while at least one path
from that card still has a current staged, unstaged, or untracked Git change;
unrelated working-copy changes do not keep the action visible.

A published Chat can precede its ACP Host binding. During an owned, error-free
start in `connecting`, the Session configuration read returns `202` with
`pending: true` and `session: null`. The Composer retains its draft without an
error or invented capabilities; Runtime revisions trigger the next fresh read.
This read-only pending state grants no mutation admission. Startup deadlines,
actual failures, and missing bindings without an active start remain explicit
errors rather than an indefinite pending response.

A fresh Chat shows the stable empty-conversation state while its Session
connects. Session startup is not an active Turn and must not enable Steer or
replace the empty state with transient startup copy. A startup-time transcript
read failure for a fresh Session cannot replace that empty state; an actual
Runtime failure remains visible through the authoritative Runtime and Composer
state. Explicit history restores may show bounded synchronization feedback
until their first authoritative transcript settles. When an expected history
read exhausts its bounded retries, Chat shows an explicit read-only Retry
action. Retry starts a fresh checkpoint read; it never replays a Prompt or any
other mutation. Once the authoritative Session or Runtime epoch changes, a
cached transcript from the previous identity is quarantined immediately and
must never render under the replacement Agent identity. Empty `202` responses,
identity-mismatched checkpoints, and delta gaps all use bounded checkpoint
retries and converge to the same explicit Retry state instead of an unbounded
loading or request loop.

A live Chat Agent uses only an explicit user rename or an Agent-managed adaptive
title above its stable provider name. Provider Session titles derived from the
first Prompt are history metadata and do not rename a live Agent. A restored
history Agent may use its durable Provider Session title when no stronger title
exists.

An unsettled authoritative transcript that already contains Turns is admitted
immediately while bounded settlement retries continue in the background.
Exhaustion exposes a read error while retaining that content; new evidence or
explicit Retry can start another bounded attempt. Only an expected history response that is still empty blocks the
transcript surface behind synchronization feedback. A delta's omitted prefix
refers to its update window, not missing browser history. Once the beginning is
loaded, subsequent deltas retain that fact unless loaded Turns are evicted;
scrolling at the top must not restart history synchronization.

Live transcript revisions coalesce behind an in-flight read instead of
repeatedly cancelling it, so sustained update streams make visible progress
without waiting for a quiet period. Rapid revision-only refreshes also share a
short bounded cadence; the latest revision must still run, while reconnect and
runtime-state transitions remain immediate. Completed Turns retain stable
render identities across these reads, so unchanged Markdown is not parsed
again. Only new intermediate messages received while the selected Chat is visible
and following the latest content fade in once, for 180 ms. The pane consumes message
identities when each snapshot arrives; mounting a message never triggers motion.
Streaming extensions and final answers display directly. Initial history, Agent
switching, expanded content, history loading, reconnect recovery, and background
catch-up display without replay. Reading older content or selecting text suppresses
arrival motion, as do reduced-motion preferences. Multiple arrivals fade in parallel.
Expanded reasoning omits a leading line that already serves as its folded title and renders the remaining
text as safe Markdown, so provider-authored emphasis is presented instead of
exposing its source markers. Shell variable expansions in prose remain literal:
paired dollar signs in quoted commands must not turn paths into inline math.
Genuine inline/display formulas and code spans retain their normal rendering.

The latest live answer mounts every authoritative snapshot that crosses the
bounded revision-read cadence. Farming must not hold prefix-extending text until
Turn completion: readers see ordered intermediate progress without per-token
render churn. Navigation, recovery, and completion reconcile directly to the
current authoritative result instead of replaying already received text.

The bottom Live Activity uses one motion cue at a time: processing keeps its
spinner without a sweep, while non-spinning activity uses a slower linear sweep.
While a structured tool remains active, the same lightweight line shows the age
of that tool's latest authoritative activity. The Runtime Host records that time
only when it receives a real provider tool update; silence ages the displayed
time and never creates a heartbeat. History replay does not restamp old updates,
checkpoints preserve the recorded time, and completed, failed, cancelled, or
interrupted work shows no live recency.

The Composer preserves drafts, IME behavior, attachments, queue/steer controls,
permissions, and negotiated configuration. Reload may restore an unresolved
submission as a visible item requiring reconciliation, but never resubmits it
automatically.
Chat and Terminal share the [Composer input contract](composer-input.md),
including bounded mobile growth and expanded editing of the same draft.

## Acceptance Criteria

Every supported provider must pass the same provider-neutral verification for
the contracts it implements. Verification must cover provider capability
negotiation, exact identity and Agent Home isolation, configuration fallback,
ordered mutations, uncertain outcomes, Server and Host restart,
checkpoint/delta gaps, reading-position restore, Chat/Terminal switching,
Fork, media and tool evidence, and large multi-Agent workloads. Scale tests
must measure process count, memory, wire volume, browser render work, and
navigation latency without imposing a fixed concurrency ceiling.


### Streaming rich content and inspection

Turn and message state own whether content is streaming, settled or interrupted.
An unfinished Mermaid fence uses a stable neutral generating surface; a closed
block renders immediately, without waiting for Turn completion. An interrupted
unfinished block remains visibly incomplete. Settled content is validated even
when Markdown omits a closing fence. Incomplete math remains readable without a
transient parser error; settled invalid math retains its diagnostic. Ordinary
prose, code and tables continue through the live snapshot cadence.

A diagram block owns one running render and one latest desired revision. Only
the current revision may publish; old queued work is skipped, the final revision
must run, and asynchronous rendering has a bounded failure with a render-only
Retry. Source and appearance updates retain the previous valid diagram while
repainting. Unmount revokes publication and releases timers. Code and CRT share
this content-state and scheduling contract while retaining their product skins.

Viewing intent is independent of render state. Updates and appearance changes
preserve an open viewer, zoom and pan. Closing or removing its owning content
releases the viewer without replaying Agent work. Image and diagram inspection
use the shared full-viewport content shell, with an application-level portal,
background isolation, top-layer Escape, a focus loop and focus return. The shell
owns title, actions and viewport geometry; content owns fit, zoom and pan.
Diagram labels use an 18px natural size. Initial inline rendering and each full
viewer opening fit the complete diagram to the available viewport. Fit follows
container resizing; zoom and pan remain explicit user adjustments. The zoom
percentage restores actual size (100%), and Fit returns to the complete overview.
Diagram answers use the available reading-column width. Controls occupy a separate
row so they cannot obscure nodes. These rules also apply to file previews.
Inline placeholders retain reading geometry while the viewer is open. File
reading-width changes remain layout operations under their existing owner.

Acceptance observes the entire update sequence, including unfinished and
invalid syntax, completion, interruption, late results and unmount. Compose
viewers with sidebar, Composer and nested interaction layers; verify real SVG
bounds, hit testing, focus and preserved viewing intent in Light, Dark, Paper
and initial narrow/touch layouts. Appearance changes must preserve identifiable
diagram node shapes, not only readable text.

Diagram gestures have one transform owner, shared by inline and fullscreen views.
Wheel zoom requires Ctrl or Alt and keeps the point under the pointer fixed;
ordinary wheel input remains available for reading. Two-finger pinch and double
click/tap zoom operate around the gesture position. The pan control enables drag
panning; disabling it permits ordinary one-finger page scrolling. Fit and actual
size cancel the current transform and recenter. Fullscreen entry starts fitted,
while closing restores the saved inline transform. Source/appearance updates do
not recreate the gesture owner; removing content releases its listeners and work.
The gesture library owns scale/translation and gesture cancellation, while Farming
owns fit dimensions, toolbar state, render revisions and viewer lifetime.

### Read-only Goal and interrupted Turns

Goal is provider-owned session metadata, displayed beside Plan in the activity
dock. A valid ACP `session_info_update._meta.goal` replaces the read-only
objective, status, and optional reported usage; omission preserves it and
explicit null clears it. Invalid payloads do not erase valid state. Revisioned
snapshots and checkpoints preserve it across reconnects; switching Agents clears
the previous preview. The dock does not create, pause, resume, complete, or clear
Goals. Stop retains its current-Turn cancellation semantics.

Cancellation remains owned by the runtime's exact Turn and response barrier.
Only settlement cancels outstanding tools/compaction, preserves successful tool
results, and records a terminal reason with the Turn. The collapsed process summary
explicitly shows interruption. Late tool updates cannot
reopen cancelled entries. A follow-up waits for the previous cancellation to
settle; stale completions cannot settle a newer Turn. Timeout remains an explicit
runtime failure. Historical interruption survives subsequent Turns and checkpoint
recovery instead of depending on the session's latest stop reason.
