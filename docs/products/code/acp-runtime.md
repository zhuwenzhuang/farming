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

The host and Farming-owned bridges use the ACP v1 SDK app API with its explicit
unstable entrypoint, preserving negotiated Fork, elicitation, system-prompt and
subagent fields. SDK package upgrades do not change the wire protocol version.
Prepared third-party adapters retain their own locked SDK dependencies; the host's
SDK pin must not override an adapter's independently reviewed protocol runtime.

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

New-Agent permission defaults are resolved by the backend at launch. The Config's
skip-permission default takes precedence over saved launch-profile defaults;
an explicit per-launch permission choice takes precedence over that default.
Browsers must not submit cached defaults as explicit choices. Changing the global
default does not change existing Sessions' permissions.

Accepted model, reasoning and Fast changes update only the requested new-Agent
Home defaults in the same Config, after verifying exact Home identity. Restoration
does not rewrite defaults. Session success with a failed default save is reported
as partial success, without replaying the mutation. Queued configuration applies
before subsequent input; only a confirmed applied model change creates a durable
transcript boundary. Initial model selection before the first input creates no
boundary. Later changes remain pending until the next input is sent; selections
between inputs coalesce into one boundary, and reverting to the previous model
removes it. Pending/applied state is checkpointed independently of history anchors;
compaction or incomplete replay cannot turn an unused choice into applied history.

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
| New request → admitted | Valid identity, capability, content hash and in-memory admission within one deadline |
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

Provider-owned Turns have no Farming-imposed elapsed-time or output-silence
limit, across providers and root or child Sessions. Long tool execution remains
running until a provider outcome, explicit cancellation, or authoritative failure.
Adapters disable optional CLI turn time limits. Initialization, admission, control,
read and cancellation-cleanup deadlines remain bounded; an observation deadline
does not end execution, and a provider timeout must not be reported as completion.
Provider service limits and explicitly requested tool or goal budgets remain
independent of Farming's Turn lifetime.

Antigravity implements Steering by hard-stopping the current CLI cycle and
continuing the same native conversation. Interrupted tools retain an explicit
failure with unconfirmed completion; continuation cannot turn them into success.
Model and effort slash changes become active only after a successful native result
and clean process exit, then publish the confirmed configuration to the UI.

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

Adapters distinguish message deltas from cumulative snapshots and preserve native
message boundaries. Final results reconcile with streamed text: an echo is not
repeated, an extension contributes its suffix, and a distinct final answer remains
visible after progress. Contradictory snapshots fail explicitly. Antigravity
history restores tool outputs from native result steps; a planner tool declaration
alone cannot prove completion. Missing or interrupted results remain visibly
unconfirmed, and unreadable or malformed transcripts fail the history read.

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
- Native Agent history, read through ACP, owns conversation content. Routine
  checkpoints store Farming metadata (provenance evidence, Fork/model boundaries,
  pending configuration and patch decisions), not a second full transcript.
  Preserve input evidence only where provenance verification or native media
  omissions require it. A full snapshot is reserved for an explicitly retained
  offline side-chat view or an in-memory Fork transfer. Reconnection always uses
  authoritative provider replay; a legacy checkpoint cannot authorize skipping it.
- Prompt and Steer dispatch and acknowledgement never wait for checkpoint or
  Agent-state persistence. In-memory state owns ordering and deduplication;
  background snapshots coalesce updates and cannot roll back a newer live state.
  Persistence failures are diagnostic, not provider delivery failures. After
  abrupt process loss, missing or stale admission evidence remains unresolved
  and must never cause automatic replay.

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

The shared Agent instructions default to independent work. Peer contact requires
user-requested communication or a concrete current dependency, blocker, or verified
concurrent conflict needing that recipient's action or answer. A shared repository,
host, file, or past task does not establish that need. A live process (`status:
running`) or Agent Card is not evidence of active work; inspect current `chatTurn`
state and verify resource ownership when relevant. Idle, completed, stopped, and
stale Agents should remain undisturbed without that specific need. Unknown activity
does not justify a precautionary message. Independent work continues; an unresolved
blocker is reported to the user.

Necessary requests carry current evidence and a specific action or question.
Informational messages and acknowledgements do not authorize new work or reciprocal
requests. Follow-ups require a material change or an unresolved necessary question
and a read of the original outcome. Main Agent monitoring follows the same policy
and ends when the relevant dependency resolves. This is a model instruction policy,
not a transport prohibition on authorized requests to idle live Chats. Acceptance
must distinguish speculative disk warnings to completed Agents, independent edits
to a shared file, and acknowledgement loops from genuine current resource conflicts
or user-requested contact.

Source attribution is trusted protocol metadata, separate from message content.
Composer and Host hashes bind it to the request. Text, outgoing-tool success and
quoted envelopes cannot establish receipt, sender identity or child ownership.
The runtime adds a model-visible peer envelope, preserving the human's existing
authorization; known echoes do not create duplicate messages. History restoration
requires a trusted checkpoint and the complete verified input prefix.
An unmatched trusted prefix survives subsequent checkpoints independently of the
replayed transcript. Provider adapters must remove their injected instructions
from replayed user input so recovery compares the original admitted content.

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
activity feed: send success is neither a read receipt nor task completion. Outgoing
messages share the Turn's Worked disclosure. Its collapsed summary retains the
message count and compact message rows. Each row starts with the target Agent's
assigned collaboration icon (stable by Session identity), followed by its name and a single-line, ellipsized preview. Markdown
is parsed into readable text before clipping. Rows toggle their own message detail
without expanding the entire Worked group; keyboard activation follows the same
path. Status counts are secondary tooltip details. Whole-group expansion reveals
the chronological messages and their outcomes. Disclosure is local presentation
state; no send is replayed and full message reads remain lazy and bounded.
The transcript owns status transitions and replay; disclosure state is presentation
only and never retries or cancels a send.

Receiver-owned input is visible even when the provider supplies no sender identity.
Adapters normalize complete native inputs into the shared session-message path with
`_meta.farming.messageRole: "user"`; they reuse history content conversion for live
input. Native message IDs upsert snapshots, while different IDs retain identical
text as separate messages. When a provider returns the submitted client message ID,
the adapter uses it as the input identity so native snapshots and local Steer
acknowledgements converge regardless of arrival order. Acknowledgement promotes
an earlier echo in place, preserving its entry identity; retries do not resend
the input. An admitted local echo preserves its original body and
trusted attribution. Matching an unbound active input or a verified history prefix
compares the complete ordered body; inline image/audio bytes and MIME type remain
significant, while local attachment path/URI metadata does not. Locator-only
attachments are not treated as equal without content evidence.
Input during an active execution does not complete that
execution. Missing attribution never authorizes dropping the body or inventing a
sender. Live, replay and checkpoint recovery must preserve these properties for
every supported Chat provider; protocol fixtures do not replace real-provider
acceptance.

## Handoff To A New Agent

Handoff creates an independent coding conversation in the confirmed source's
workspace using the chosen Provider and Home. It does not stop/archive the source
or migrate native state. Shell is not a source or destination.

Handoff remembers the user's last explicit Chat-or-Terminal choice in the browser,
scoped to the instance's origin and base path, across destination changes, dialog
reopening and reload. With no valid saved choice or unavailable browser storage,
Chat is the default for a destination that supports it. Terminal-only destinations
retain Terminal without overwriting that preference. Handoff never rewrites the
Provider's ordinary New Agent default, and ordinary creation does not overwrite
the Handoff preference. This is selection intent, not proof of runtime capability.

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
layout changes must not force that navigation. When Sticky turn prompt
(`stickyTurnPromptEnabled`, enabled by default in Settings → Interface) is active,
an appended human turn while following latest temporarily reserves space on send,
leaving the previous reply's tail visible. Manual scrolling shrinks unused space
below the viewport without moving the reader; leaving and re-entering Chat uses
natural content height. The jump-to-latest control indicates actual content below
the viewport, not empty runway, and remains available when history paging excludes
the live tail. Scrolling past a turn's inline user prompt pins a compact summary
of that turn's user message at the top of the viewport; clicking it returns to
the turn start. Read failure
and execution failure remain visibly distinct. Startup is not an active Turn.

Turn failures show their category and original provider reason outside the activity
disclosure, alongside any partial answer. The backend classifies the complete
provider error, including structured details; exhausted usage allowances remain
distinct from short-term rate limits and billing failures. Usage-limit feedback
identifies the Agent's account as the scope to check, retains provider reset-time
instructions without inventing a timezone, and never automatically retries work.
Unknown errors retain their original reason. Sidebar Agent previews expose the
current authoritative Turn failure without requiring activation.

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
