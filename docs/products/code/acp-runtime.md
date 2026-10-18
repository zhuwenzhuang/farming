# ACP Runtime

> Chinese version: [acp-runtime.zh_cn.md](./acp-runtime.zh_cn.md)

ACP is Farming's structured Chat boundary. The backend owns execution, session
identity, ordered conversation state and recovery. Browsers display that state;
terminal text, assistant prose and cached UI state cannot establish runtime truth.

## Ownership And Provider Boundary

| Owner | Responsibility |
| --- | --- |
| Config-local Runtime Host | Provider connections, exact process ownership, active operations and ordered transcript state |
| Farming Server | Authentication, lifecycle admission, durable requests and browser transport; replaceable controller of the Host |
| Provider adapter | Executable and Home policy, negotiated capabilities, native history and provider-specific normalization |
| Browser | Drafts, selection, disclosure and reading position; never execution or recovery authority |

Provider extensions must be versioned and negotiated. A provider name is not a
capability. Generic lifecycle and UI code consume normalized contracts, including
configuration, archive, Fork, child control and transcript policy. Unsupported
features fail explicitly. Cross-cutting improvements require equivalent acceptance
across supported providers.

ACP uses prepared, version- and integrity-pinned Farming-owned adapters. Existing
Sessions retain their exact launch identity; missing executables fail recovery
rather than selecting another one. Native Terminal has a separate executable
policy. Provider-specific constraints belong in adapters and, for Codex, the
[Codex runtime contract](codex-runtime.md).

A shared provider connection is scoped to canonical Project, Provider, canonical
Agent Home and launch identity, and requires independent multi-Session support.
Each Session retains its own configuration, permissions, workspace, MCP inputs,
Turn and recovery state. A Provider Session has at most one live owner within a
Host. Releasing one Session cannot stop another. Sharing cannot leak session
credentials or operational environment into the process-wide environment.

Browser and Computer use the instance's shared capability services. Session
identity routes requests but is not itself authorization. Operational context
and bootstrap instructions do not establish the user's preferred language.

## Session Identity And Configuration

The [Provider Session identity contract](provider-session-identity.md) owns durable
identity and scope. Temporary startup identities cannot authorize History,
resume or Fork. Private workspace directories and MCP inputs survive recovery
without becoming ordinary browser inventory.

Provider Session and Agent Home defaults apply until the user confirms an
explicit override. Persist overrides by stable option identity, never display
label. Restore them after loading the Session. A missing saved model is not proof
of removal: retain it, warn and block Prompt/Steer until restoration or explicit
replacement. Other definitively unsupported options may drop only the incompatible
override with a warning; transport failure is not compatibility evidence.

Accepted model, reasoning and Fast changes update only the requested new-Agent
Home defaults in the same Config, after verifying exact Home identity. Restoration
does not rewrite defaults. Session success with a failed default save is reported
as partial success, without replaying the mutation. Queued configuration applies
before subsequent input; only a confirmed applied model change creates a durable
transcript boundary.

Authentication required before the first Session keeps the initialized connection
and visible Agent when sign-in methods exist. Prompts remain disabled until the
provider confirms Session identity. Sign-in, failure and closing have bounded
outcomes; a late authentication result cannot recreate a closed Agent.

## Turn And Mutation Semantics

Runtime state, Turn outcome and request admission are separate facts. One Session
orders conflicting Prompt, Steer, Cancel, configuration and child operations,
fenced by binding generation and exact Turn identity.

| Transition | Required evidence |
| --- | --- |
| New request → admitted | Valid identity, capability, content hash and durable admission within one deadline |
| Duplicate → existing operation | Same request ID and identical intent; changed content is a conflict |
| Admitted → executing | Current ownership at the provider-send boundary |
| Executing → settled | Provider outcome and the admitted notification prefix; input acceptance alone is insufficient |
| Ambiguous delivery → unknown | Preserve original identity and evidence; reconcile without automatic replay |
| Cancel → interrupted | Exact Turn settlement; stale completion cannot settle a newer Turn |

Queued follow-ups remain editable/discardable until admission. Live Steering is
available only when negotiated and the backend still owns a running, unsettled
Turn. Native completion disables Steering even before the response settles.
Uncertain writes never become automatic queue fallbacks. Late acknowledgements
cannot restore busy state after completion. Provider-initiated continuation Turns
use the same start/settlement rules as submitted Turns.

Permission and elicitation requests have independent identity and validity.
Receiving a question does not suspend a Turn. Answer, decline, withdrawal and
request cancellation settle once; only the live pending set authorizes responses.
Questions remain in chronological history after settlement. Restored records
without a live resolver are read-only. “Later” collapses a question; it does not
answer or expire it. Unknown answer delivery is never replayed.

Goal metadata is provider-owned and read-only. Omission preserves it; explicit
null clears it; invalid data cannot erase valid state. Completion retains one
durable record with reported usage. Goal state is distinct from Turn activity,
and Composer Goal text alone does not create a persistent Goal binding.

## Transcript Protocol

The Host reduces typed provider history and live events into one ordered stream.
Text, tools, patches, media, permissions and related-session evidence remain
structured. Provider-specific text heuristics stay at the adapter boundary.
Reducer entry IDs identify chronological segments; a provider message resumed
after an intervening entry must not overwrite that earlier segment.

- Checkpoints identify Agent, Provider Session, runtime epoch and revision.
  Deltas require that identity and the exact previous revision; gaps, resets and
  identity changes require a new checkpoint. Stale results cannot publish.
- Reads declare their covered range. Older pages do not advance the live-tail
  revision, inherit current Turn status or become a live delta baseline. The
  browser retains a bounded contiguous window; Return to latest reads a checkpoint
  when the tail was evicted. Mixed-version historical pages are not an atomic snapshot.
- The Host bounds projection before cross-process transfer. Large tool/media
  content uses immutable, identity-bound paged reads; cursor offsets must be
  contiguous. Expiry, capacity, disconnect and identity changes terminate reads
  explicitly. Raw provider entries are not an unbounded browser payload.
- Visible panels share reference-counted revision interest. Slow consumers retain
  the latest checkpoint marker, not an unbounded event queue. Reads are single-flight
  and coalesce newer revisions without waiting for the provider to become quiet.
- Prepared projections and retained views are bounded and fenced by complete
  identity, including projection revision. They accelerate the same authoritative
  read path. Cached controls require a fresh read before becoming actionable.
- Provider replay is authoritative. Checkpoints preserve presentation metadata
  and recovery fences, but replace a full load only with proof of freshness.
  Prompt admission requires a durable dirty fence; uncertain execution leaves it
  dirty. Failed writes do not establish that proof.

Read deadlines and finite retry budgets end in visible read errors with explicit
Retry. Retry reads state; it never resends a Prompt. Identity changes quarantine
old content immediately. Valid partial content remains readable while settlement
continues, with a read error if it cannot finish.

## Related Sessions And Fork

A durable parent Session owns at most one retained Side Chat, created through the
existing Fork admission. It inherits context, not authorization to continue the
parent's task. Parent and child own independent drafts, controls and Turns.
Opening or closing a pane changes observation, not execution.

Native child IDs and capabilities are fenced to their immediate parent runtime
generation. Associations precede child traffic and cannot change ownership.
Only authoritative child evidence settles a child: parent completion/cancellation
and unknown activity cannot synthesize child outcomes. Fresh bounded inventory
is used when negotiated; unavailable inventory is an error, not an empty list.
History reads verify ancestry and do not start, load, resume or cancel Sessions.

Related history is bounded by turns, items and bytes, with identity-bound cursors.
Presentation segments must not trim an already bounded provider page again.
Native children keep one identity across resumed Turns; stale output from an older
Turn cannot change the new one. Quoting child content appends to the parent's
draft and never sends it automatically.

Fork requires a proven stable conversation boundary. During an active Turn it is
allowed only when the adapter can fork before that Turn without interrupting it
or copying partial output. The child must load in its own Agent environment;
a distinct Session ID alone does not prove isolation. Definitive creation failure
permits exact cleanup; uncertain launch retains the child for reconciliation.
Restart does not replay a pending Fork or guess missing ownership.

The child owns a durable inherited-history boundary. Recovery verifies the ordered
user-input prefix before rebinding it to replayed entries. Missing/compacted
history exposes an unavailable boundary instead of moving it or guessing.

Idle Side Chats may release their runtime after five minutes, or one minute
without explicitly attached supervision; release rechecks idleness. Active work,
pending input and native child activity prevent release. History remains retained;
an explicit new message resumes the Session without replaying old input.
Parent archive includes owned Side Chats and proven native descendants. Failure
or incomplete inventory blocks success. Parent stop releases exact owned children
and Resources; an unavailable parent rejects child input.

## Agent Communication And A2A

Source attribution is trusted protocol metadata, separate from message content.
Composer and Host hashes bind it to the request. Text, outgoing-tool success and
quoted envelopes cannot establish receipt, sender identity or child ownership.
The runtime adds a model-visible peer envelope, preserving the human's existing
authorization; known echoes do not create duplicate messages. History restoration
requires a trusted checkpoint and the complete verified input prefix.

| Contract | Meaning |
| --- | --- |
| Transport | Official A2A SDK embedded in the existing backend; authenticated JSON-RPC at `/api/a2a/agents/:agentId` under the configured base path |
| Capability | Text SendMessage, GetTask, ListTasks, status/result streaming, resubscription, exact running-request cancellation and protected Agent Card; push notifications, arbitrary media and Task continuation are unsupported |
| Identity | Local Agent credentials; external owner-issued grants scoped to exact recipients and expiry, separate from owner credentials |
| Delivery | New requests require a live recipient Chat and, for local sends, a live source; dispatch rechecks exact recipient Session; queued Prompt by default, never raw Terminal input |
| Completion | The correlated final assistant text completes the Task, not input admission or a notification summary |
| Recovery | Durable Config-local deduplication by caller and message ID; changed intent conflicts; unknown execution is never replayed |
| Follow-up | New Task with one `referenceTaskIds` reference; same-direction follow-up or reverse reply requires the original participants and exact Sessions; no reopening completed Tasks |

SendMessage waits for a terminal or interrupted outcome unless
`configuration.returnImmediately` is true. Observation is bounded to 60 seconds;
a timeout or disconnected stream does not cancel or replay execution. Streams
start with the authoritative Task snapshot and publish status changes and final
result artifacts, not provider thought/token deltas. Reconnect by querying or
subscribing to the original Task. Credentials are revalidated during observation.

ListTasks exposes only the caller's requests to the selected recipient, with
bounded pagination and context/status/time filters. Artifacts require explicit
inclusion; history can be trimmed. A Task represents one request and its result,
not a workspace TODO or scheduler entry.

Cancellation targets the original Host prompt's binding and turn handle. Queued
requests without a provider-owned turn, unknown outcomes and settled work reject
cancellation; they must never cancel a newer turn. An acknowledgement alone is
insufficient: only the correlated canceled receipt establishes canceled status.
Proven execution failure becomes failed; ambiguous dispatch remains unknown.

GetTask may resolve unknown outcome only from the original settled Host receipt
matching binding, Session and request hash. Lost/replaced Host evidence remains
unknown. Authorized callers can read saved results after a recipient stops.
Revocation prevents future access, including result reads, without cancelling
accepted work. A peer ID remains the same principal across grants.

Session launch credentials use `FARMING_COMMUNICATION_TOKEN`, excluded from
shared process environments, and expire after 30 days; relaunch obtains a new one.
External grants default to 24 hours and allow at most 30 days. Tokens are returned
only at issuance; storage retains digests. `FARMING_PUBLIC_ORIGIN` supplies the
advertised endpoint origin when configured (required when a reverse proxy changes
the public scheme or host). Otherwise Agent Cards use the authenticated request's
origin rather than a loopback address.

The initial journal retains at most 1,024 requests / 32 MiB per Config and does
not silently evict deduplication evidence. Capacity exhaustion is explicit.
Text input/output is bounded to 64 KiB; at most 32 requests execute concurrently
per Config, and each principal has 120 protocol calls/minute including polling. At most eight protocol requests remain open per principal,
with a Config-wide limit of 128.

`farming message send` requires `--id`; `get` and bounded `watch` retrieve results,
`list` finds caller-owned requests, `subscribe` emits bounded status/result events,
`cancel` targets the original running request, `--reply-to` links a new request,
and `card` reads capability. Owners manage
external access with `message grant`, `grants` and `revoke`. The recipient's
final answer returns automatically. `farming send` retains raw Terminal semantics.

External A2A access is an optional built-in plugin, disabled by default. Owners
open Plugins → Farming → External Agent access · A2A to enable it, select a live
Chat Agent and create a scoped, one-time credential. CLI grant issuance also
requires the plugin to be enabled. Incoming messages use the existing Chat
transcript with external source attribution; there is no separate Agent messages
dialog or human send-on-behalf form.

Disabling blocks external requests and ends existing external observation without
cancelling accepted work. Grants remain stored; reenabling restores unexpired,
unrevoked grants. Internal Agent communication is independent of this switch.
See the [extension model](extension-model.md#external-agent-access-a2a) for ownership
and recovery contracts.

Incoming bubbles retain receive-time sender names, recorded times and distinct
message IDs across replay and renames. Native navigation requires exact
Provider/Home/Session identity; local Farming navigation also requires the exact
sender Agent ID and Session key. Missing, ambiguous and external identities remain
plain labels. Clicking a source selects it without resuming execution.
Native encrypted receipts show unavailable readable content, never ciphertext or
sender-side reconstruction. Outgoing native collaboration is a chronological
activity feed: send success is neither a read receipt nor task completion.

## Handoff To A New Agent

Handoff creates an independent coding conversation in the confirmed source's
workspace using the chosen Provider and Home. It does not stop/archive the source
or migrate native state. Shell is not a source or destination.

The initial prompt identifies native source records, asks the destination to read
before responding, preserve the user's language, state its understanding and wait.
Those records are background, not permission to continue work, and remain mutable
native history rather than a promised full-context snapshot. Unreadable records
must be reported. Trusted handoff presentation metadata survives replay only
through the verified input-prefix rule; text alone never establishes provenance.

Creation and initial input use existing identified admission. Duplicate intent
joins the recorded result; changed intent conflicts; uncertainty never replays
input. Closing the dialog does not cancel admitted creation. A delivery failure
retains the created Agent identity when available. Terminal delivery follows the
shared paste-and-submit contract. Launch defaults are backend-owned; unsupported
Chat startup never silently becomes Terminal.

## Lifecycle And Recovery

| Event | Required outcome |
| --- | --- |
| Compatible Server connection loss | Reattach the existing Host and recover authoritative state; healthy Sessions and active Turns remain owned |
| Host/adapter loss | Prove old-process ownership, restore exact Session/private scope and overrides, reload history; unresolved execution is failed or unknown, never replayed |
| Full stop / `npm restart` | Hard-kill the complete selected Farming-owned process set, including Host and providers; start a fresh generation |
| Chat/Terminal switch | Reject active Turns; prove resumable identity and release ownership before replacement; restore the original runtime if target startup fails |
| Archive | Serialize with resume and other exact-Session lifecycle mutations; confirm provider archive before removing membership |

Server-only reconnection is failure recovery, not a second intentional stop mode.
Ordinary startup must not replace an incompatible Host owning live Sessions.
Missing bindings schedule exact cold recovery; one unavailable runtime family
cannot block Server readiness or unrelated Terminal/Files functionality.
Cold recovery materializes inventory first and prepares Sessions with bounded
parallelism without changing membership order. Recovery itself is not Agent activity.

Controller callbacks settle only on their matching result, disconnect or deadline.
Transport acceptance/backpressure is not callback completion. Controller changes
invalidate prior callbacks and reservations; detached sockets and stale bindings
cannot publish. Uncertain results are never retransmitted through another connection.

Live archive uses the negotiated provider connection when supported, including
submitted but unfinished Sessions. Failure cannot fall back to another mutation
process. Explicit retry reads authoritative history before deciding what remains.
Unsubscribe alone is not proof that a provider released its writer.

## Presentation And Acceptance

Chat shares [Composer](composer-input.md), [UI design](../../development/ui-design-protocol.md)
and [interaction](../../development/ui-interaction-protocol.md) contracts. Keep
conversation progress readable, detailed evidence reversible and live activity
compact. User disclosure and history-reading intent survive updates and settlement.
Accepted input may reveal latest content; background updates, pagination and
layout changes must not force that navigation. Read failure and execution failure
remain visibly distinct. Startup is not an active Turn.

Rich content uses safe Markdown and bounded media/render paths. Source is preserved;
untrusted HTML does not execute. Streaming, settled and interrupted content have
explicit states. During streaming, inline links and images with an opened destination
remain hidden until the destination closes, including inside table cells; growing
URLs must not affect table width. Settlement or interruption reveals any unfinished
source. Code spans and completed links retain normal Markdown behavior.
Only the current render revision may publish; failure has a
bounded render-only Retry. Viewers preserve reading/zoom intent and share focus,
Escape and background-isolation rules. Render retries never replay Agent work.

Acceptance covers identity/Home isolation, negotiated capability, ordering,
deduplication, cancellation, late results, reconnect and hard loss; compares live
projection with authoritative snapshots; and exercises pagination, large payloads,
Fork/child isolation and source attribution. Verify composed desktop/compact
interfaces in Light, Dark and Paper. Real-provider smokes are isolated and
low-volume; deterministic fake providers cover routine failure sequences.
