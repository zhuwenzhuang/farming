# Related Sessions And Side Chat

> Chinese version: [related-sessions-design.zh_cn.md](./related-sessions-design.zh_cn.md)

Status: proposed design. This document defines the intended product and acceptance
contract; it does not claim that these controls or provider capabilities have shipped.
The existing [ACP runtime](acp-runtime.md), [Session identity](provider-session-identity.md),
[Agent list](agent-list-state-protocol.md), [UI design](../../development/ui-design-protocol.md)
and [interaction](../../development/ui-interaction-protocol.md) contracts remain authoritative.

## Product Decision

A user can ask a side question while the parent Agent continues working. Side Chat
uses an independent conversation with an explicit context snapshot. Its messages
do not enter the parent's conversation automatically.

User-created side chats and provider-created subagents share a related-session
list, transcript presentation, attention indicators and capability-driven controls.
Their purpose and controller remain explicit. A child reported by a provider is
not automatically a Session that Farming can prompt, resume, close or delete.

The initial design provides one retained side chat per parent Provider Session.
Repeated opening returns to that conversation; ending it retains its history;
deleting it permits a fresh snapshot and conversation. Ordinary Conversation Fork
continues to create an independent task. Existing forks are not reclassified.
Nested user-created side chats, promotion, automatic result merging, worktree
creation and Farming-owned subagent orchestration are outside the first delivery.

## Sidebar And Conversation View

```text
Project
  v Fix login                         Running
      Side chat · Cache behavior      Replying
      Subagent · Inspect invalidation Running
      Subagent · Add regression tests Completed
  > Improve build speed               Completed
```

Related rows appear directly beneath their parent, using one shared navigation-row
family with an indented hierarchy variant. Purpose has a shared chat/Agent icon
and an accessible label; the title is a short topic or delegated task. There is
no permanent intermediate "Subagents" group. The side-chat row comes first;
delegated rows keep stable creation order rather than moving on every update.
Large collections use bounded paging and the shared Show more interaction;
backend totals cover children outside the visible page.

Provider-created children update the list without stealing selection, expanding
ancestors or scrolling away from the user's current work.

- The Side Chat command is available in the existing parent action menu. Opening
  it expands the parent and activates the child after creation settles. Repeated
  clicks and multiple browsers join the same backend operation.
- Selecting the parent shows its existing Chat or Terminal. Selecting a child
  opens its conversation in the existing work pane. A compact breadcrumb identifies
  its parent and purpose and links back to the parent; no new header toolbar is added. A second split
  pane is not required. Parent execution continues while a child is visible.
- Only the selected row receives the shared selection surface. Selecting a child
  does not also select its parent. Hover and selection use the same surface; no
  left-edge marker is added. Shared geometry and typography apply in Light, Dark
  and Paper. Compact navigation uses the existing drawer and full-width work pane.
- Collapsing a parent does not stop children. A separate related-session indicator
  summarizes active, waiting, failed and unread children without changing the
  parent's own runtime status. Waiting or failed children remain discoverable even
  when pagination or ancestor collapse hides their rows.
- Reading the parent does not mark a child read. Read cursors belong to the exact
  child and advance only under the normal visible/latest-content rules. Parent
  attention can include child attention; aggregate counts must not count that
  propagation as a second working task. Provider-native children without separate
  Farming runtimes must not inflate the live Farming Agent count.
- Pinning or moving a parent carries its related rows with it. Related rows do not
  independently appear in Pinned or as duplicate top-level history rows. Search
  results retain their parent path and open the same identity. Parent pagination
  counts parents independently of their nested children.

The transcript reuses Chat rendering, draft ownership, history scrolling, tool
details and permission cards. Native-child previews in a parent tool call link to
the same child view rather than creating another transcript owner. A child with
no prompt capability is an inspectable transcript with an explicit control-owner
label and no enabled composer.

## Actions And Retention

| User action | Runtime effect | History and navigation |
| --- | --- | --- |
| Back, switch task, collapse parent, dismiss a menu | None | Preserve the conversation and running indicator |
| Stop reply | Cancel this child's current Turn, when supported | Preserve the Session and allow a later message |
| Open ended side chat | Read history without starting a runtime | Resume the same Session only when the user sends a new message |
| Delete side chat | Settle owned runtime cleanup, then delete exact provider history | Remove the related row only after confirmed completion |
| Copy to parent draft | None | Put user-selected content into the parent's ordinary draft, without overwriting an existing draft or sending automatically |

There is no End button or dedicated close-side-chat control. Runtime release is
automatic under the reclamation policy below; the user can keep reading retained
history. Escape and outside-pointer dismissal remain local navigation/overlay
operations under the shared interaction contract and never issue Delete implicitly.
Copy to parent draft preserves the source reference and requires ordinary user
submission; a busy parent uses its existing Prompt/Steer/queue policy.

Persistent side chats have no separate automatic history-expiry policy in the first
delivery. Explicit deletion and existing authorized parent/Project deletion own
record removal. A provider without exact history deletion still supports automatic
runtime release, but exposes no misleading Delete action. Truly ephemeral provider sessions cannot satisfy the
retained-side-chat contract and are not silently used for it.

## Identity, Ownership And Capabilities

The backend extends its existing Session metadata and lifecycle journal with
the related-session association. It owns the parent relation, purpose, control
owner, snapshot provenance and operation outcome. Browser state owns selection,
expansion and drafts only; provider notifications own native execution facts.

Related rows and aggregates extend the existing versioned list snapshot/delta
projection. They share its generation, ordering, scoped-completeness and recovery
rules. Adapters feed the backend projection; browsers do not independently build
a second child inventory from raw transcript events.

| Concern | Contract |
| --- | --- |
| Identity | Use the canonical `(provider, providerHomeId, sessionId)` when it denotes a real Provider Session. Runtime Agent IDs are attachments, not durable parent keys. |
| Native child identity | An opaque notification ID is scoped to its exact parent runtime generation until the adapter proves a durable Provider Session mapping. It must not be passed to history APIs by guessing. |
| Purpose | Side question or delegated work; purpose alone grants no control capability. |
| Controller | Farming owns its explicitly created side Session; the provider owns its native delegation and result return. |
| Capabilities | Project actual per-child read, prompt, cancel, resume, release and delete support. Absent or unknown support grants no mutation. |
| Snapshot | Record the exact parent identity and provider-owned context boundary; reopening never silently takes a newer snapshot. |

A Session has one live runtime owner, including when it can also be discovered in
provider history. Association edges must not create cycles. Native nesting retains
the provider's actual parent relation and uses the same row family; the one-side-chat
rule is a product rule, not a limit on native subagent count. Descendants started
by a side chat belong to that side runtime's cleanup scope, not to the main task.

Capabilities are the intersection of the pinned adapter's verified contract, live
negotiation and exact child ownership. A connection-level method declaration or
a `subagent_spawned` event does not grant that method on every child. Native
child controls stay with the provider adapter; Farming must not impersonate the
parent Agent or create a replacement fork to make an unsupported control appear
successful. Legacy metadata and newer typed notifications normalize at that
boundary and do not leak into generic UI code.

## Creating And Continuing A Side Chat

Creation reuses Conversation Fork admission, provider launch/configuration and
durable lifecycle settlement. The resulting membership is related rather than
top-level. The first delivery uses a provider-owned boundary before the active
Turn, consistent with the current ACP contract; it does not copy unfinished tool
calls. The parent is never cancelled, steered, switched or reloaded to make a fork.

The child header shows "Context through the last completed turn" and an available
source reference. An active parent's partial answer and future changes are not
included. If no safe boundary is available, report that reason without queueing
an invisible fork behind the parent's entire running Turn. A provider limited to
idle fork can expose it while idle, but does not qualify as running Side Chat.

Supporting a snapshot of current saved progress is a later adapter contract:
it must prove consistent copying during writes/compaction, repair unfinished tool
pairs for child continuation, and keep inherited pending work from appearing as
live child execution. That change must update the owning ACP runtime contract
before activation. Removing an idle guard alone is insufficient.

Inherited context is reference material. Provider-side bootstrap tells the child
to answer the user's side question and not autonomously continue the parent's
task or Goal. Child model, permissions, environment and tool scope pass through
the existing adapter configuration boundary without privilege escalation. Tool
requests and results remain attributed to the child. Conversation isolation does
not isolate files: the first delivery shares the existing workspace and does not
claim a filesystem snapshot or create a worktree.

Opening an existing side chat does not refresh its parent context. The header
continues to expose the original boundary. Users can supply selected newer
information through an ordinary message, or explicitly delete and start again.

## Minimal State-Transition Model

Use the existing runtime states; related-session membership is not a second
Agent lifecycle. Resource attachment, Turn activity and retained history are
separate facts. The labels below describe operations, not another runtime enum.

| Trigger | Guard / authoritative owner | Effect and bounded outcome |
| --- | --- | --- |
| Open side chat | Backend serializes the parent's single retained side slot | Return its existing identity, or durably record one creation intent before calling the provider |
| Fork completes | Operation identity and source boundary still match | Persist child identity and related membership before publishing success; stale browser intent cannot navigate |
| Fork rejected | Definitive provider failure, no unresolved child | Publish failure and release the reserved slot; explicit retry may create a new operation |
| Fork result uncertain | Timeout, lost response, or crash around identity publication | Retain the journal and reservation; reconcile without replaying creation or claiming that no child exists |
| Send to retained child | Current capability, owner and operation generation match | Resume exactly that Session when needed, then admit one identified Prompt through the existing queue |
| Stop reply | Exact child Turn is active and cancellation is supported | Cancel only that Turn; observe completion or an explicit cancellation failure by the existing deadline |
| End / resource eviction | Backend fences further admissions for that child | Reconcile pending input, release exact owned resources and persist retained state; failure remains visible as cleanup failure/uncertainty |
| Delete | Exact child identity; deletion supported; creation/resume settled | Prevent resume, finish owned cleanup, delete stored Session, then remove membership; uncertain deletion retains a reconcilable tombstone |
| Native child update | Adapter proves parent and generation | Upsert execution state; stale updates cannot resurrect a deleted or superseded child; incomplete snapshots are not deletion evidence |
| Server restart | Existing lifecycle recovery and exact ownership | Reconcile unfinished operations before admitting input; retained records do not auto-start, auto-refork or replay messages |

Creation, resume, End, Delete and parent destruction serialize at the same owner.
Duplicate requests with the same operation identity join; changed payloads do not.
An End arriving during creation records the intended terminal state and releases
the exact child if it materializes. If its identity is still unknown, the operation
stays uncertain; it must not reopen the slot and leak a second fork. Cleanup and
deletion acknowledgements are not optimistic UI removal.

## Resource Reclamation And Parent Lifecycle

Ending the runtime is an internal lifecycle operation, not a new user-facing
button. It reuses the existing Agent/ACP release path, including child-owned bindings,
subscriptions, pending permissions, elicitation, terminals and external Resources.
It does not introduce a graceful-stop alternative. Process stopping preserves
Farming's single hard-stop contract; an optional ACP Session release is only part
of the established shared-runtime boundary. Never kill a shared provider process
to dispose of one child while unrelated Sessions still own it. If independent
release cannot be proven, that adapter cannot offer the complete side-chat contract.

Proposed initial resource deadlines are five minutes of idle time after a settled
Turn (or creation without input), and sixty seconds after the last supervising
browser loses its side-chat attachment. Idle eviction requires no active Turn,
permission/elicitation, child work or owned asynchronous work. These deadlines
release resources and retain history; they are not history expiration. A reconnect
during the sixty-second window retains the runtime; expiry invokes the same End
operation even if the side chat is still answering.

Supervision uses an explicit related-session interest on the existing authenticated
workspace connection, independent of transcript visibility. Returning to the parent
keeps that interest; opening history elsewhere or merely listing a Project does
not acquire it. Creating a side chat or explicitly sending to a retained one
acquires interest before runtime admission. Multiple browsers are counted by exact connection and child
identity. Heartbeat/liveness and a bounded backend expiry queue are shared
infrastructure; do not add per-row browser polling or depend on `beforeunload`.
The backend retains the last supervision deadline and reconciles it after restart.
Activity after a deadline races through the same operation owner: it may prevent
eviction before admission, but cannot reopen a child whose End already began.

These resource deadlines apply to Farming-owned side chats only. Provider-native
delegation follows its parent runtime's lifecycle and is not cancelled because a
viewer closes a panel. Ending the main Agent includes its Farming-owned active
side chats and provider-owned descendants in the exact selected cleanup scope.
Natural completion of a parent Turn does not end a user's ongoing side chat.

Archiving a parent ends attached side runtimes, preserves related history under
the archived parent and hides the whole group after success. Parent/Project
deletion enumerates and settles owned children before removal; unsupported or
uncertain child deletion remains explicit rather than silently leaving hidden
owned resources. Native provider history is removed only under its proven deletion
contract. A parent missing from an incomplete history scan is not a cascade trigger.

## ACP And Terminal Boundary

The runtime chooses one declared adapter strategy: native ACP fork, a verified
provider side-session extension, or unavailable. A provider extension must meet
the same snapshot, identity, continuation and cleanup acceptance as native fork.
Protocol Draft/extension status and provider capability are independent checks.

A provider-backed Terminal may expose Farming Side Chat only when its adapter
can resolve the exact parent Session and independently create a structured child
without claiming, loading or interrupting the live parent runtime. It then uses
the same related-session model and ACP child view. A plain Shell cannot supply
that context and has no automatic Side Chat command.

Commands such as native `/side` or `/btw` typed inside a Terminal remain owned by
that CLI. Farming does not parse terminal text into related-session ownership,
inject such commands, or simulate the feature by switching the parent's runtime.
Code is the initial creation UI. CRT consumes the same backend identity, status
and cleanup truth; surfaces without related-session navigation must show that
related work exists and provide a route to the Code view rather than hide it.

## Delivery And Acceptance

1. Add the backend association and capability projection with deterministic fake
   providers. Normalize native children into it without changing their controller.
2. Add the shared sidebar rows and existing transcript/composer composition; wire
   creation, retained reopen, deletion and automatic bounded reclamation together.
   Do not ship creation with cleanup deferred to a later phase.
3. Enable each adapter only after the common end-to-end criteria pass. Running
   Side Chat requires the active-parent case; idle-only support stays clearly scoped.
   Terminal entry is enabled separately after exact identity and non-interruption proof.

| Acceptance area | Required evidence |
| --- | --- |
| Running parent | Hold the parent's Prompt and tool output open; create and converse with the child; prove the parent receives no cancel/switch and completes normally |
| Snapshot | Verify the displayed boundary, excluded partial output, unchanged source, isolated child messages and successful child continuation |
| Shared identity | Same parent across browsers creates one side chat; identical IDs in different Homes stay distinct; native synthetic IDs never become guessed history identities |
| Controls | Read-only native child, cancellable-only child and full side chat expose exactly their verified actions; stale capabilities and generations reject mutation |
| Ordering and failure | Duplicate open/send, End during fork, send versus eviction, delete versus resume, out-of-order events and response loss reconcile without duplicate work |
| Cleanup | Exact child processes, bindings, tool resources and interactions are reclaimed; shared siblings survive; all idle/disconnect expiry and cleanup-failure paths terminate visibly |
| Restart and retention | Hard process loss at each creation/deletion stage preserves exact reconciliation; history opens without inference; missing/incomplete inventory never causes guessed deletion |
| Parent lifecycle | Natural completion, explicit End, archive, delete and native descendants obey their distinct ownership and retention rules |
| Composed UI | Running parent plus streaming child, waiting native child, long titles, paged children, unread state, collapse, pins, search, keyboard and touch work in Light/Dark/Paper and compact layouts |
| Cost and scale | Collapsed rows do not load full child transcripts or spawn runtimes; bounded pages/deltas and exact fixture cleanup hold for many parents and native children |

Provider enablement requires low-volume isolated real-provider smokes in addition
to deterministic tests. Source inspection or a successful fork response alone
does not certify continuation, runtime reclamation or Terminal interoperability.
