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
Repeated opening returns to that conversation; automatic runtime release retains its history;
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
no permanent intermediate "Subagents" group or aggregate status row. Related icons
occupy the indentation gutter inside the selection surface without shifting
labels or subsequent rows. Finished grouping preserves the same child hierarchy
and label position. The side-chat row comes first;
delegated rows keep stable creation order rather than moving on every update.
Large collections use bounded paging and the shared Show more interaction;
backend totals cover children outside the visible page.

Provider-created children update the list without stealing selection, expanding
ancestors or scrolling away from the user's current work.

A parent with related rows offers the existing eye/eye-off visibility control
inside its ordinary row actions, using the same hover and keyboard-focus reveal
rules as its sibling buttons. The compact layout exposes the same action in the
existing row menu. The browser sidebar owns expanded/collapsed state per parent
Agent and Provider Session identity. It starts expanded and changes
only on an explicit toggle; selection, inventory updates and row remounts do not
expand it. A new parent session starts expanded. Collapsing hides side chats,
native children and their finished group, while preserving the open details,
pagination and child execution. Inventory refresh and its bounded error handling
continue unchanged; the toggle performs no runtime mutation.

Native-child inventory reads require an established parent Provider Session and
a readable ACP runtime (idle, working, waiting, or interrupting). Starting,
connecting and reconnecting are parent lifecycle states, not child inventory
failures, and must not insert a temporary Retry row. Becoming readable starts
one bounded read; later revisions coalesce serial refreshes. Losing readiness,
changing parent identity or unmounting cancels obsolete reads. An admitted read
failure remains explicit and retryable; an empty successful inventory adds no
child rows.

- The Side Chat command is available in the existing parent action menu. Opening
  it expands the parent and activates the child after creation settles. Repeated
  clicks and multiple browsers join the same backend operation.
- Selecting the parent shows its existing Chat or Terminal. Selecting a child
  opens the shared related-conversation pane on the right, keeping its parent
  visible on the left. This applies equally to Side Chat and native subagents.
  A compact pane heading identifies the child and its parent; no app-level toolbar
  is added. Parent execution continues while a child is visible.
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

## Parallel Conversation Layout

On a sufficiently wide desktop, the workspace has three regions: existing
navigation, the parent work pane, and one related-conversation pane. Side Chat
and provider-native subagents use the **same opening and placement behavior**.
The right pane is a persistent content surface, not a modal, drawer or popover.

```text
Navigation             Parent work pane             Related conversation
Project                Fix login                    Side chat · Cache behavior
  Fix login            Chat / Terminal              Parent: Fix login · snapshot
    Side chat          Parent transcript            Child transcript
    Subagent           Parent continues working     Child status / permissions
                       Parent composer              Child composer if supported
```

- Clicking either kind of child, including a link in a parent tool call, resolves
  the authoritative relation, keeps the parent on the left, and opens that exact
  child on the right. For a nested native child, its direct parent is the left
  conversation; the compact ancestor path provides navigation back to the root.
  Never recursively add a third conversation column.
- Selecting another child replaces only the right conversation. Each Session
  retains its own draft, attachments, scroll anchor, unread cursor and pending
  permissions. Selecting the displayed parent focuses the left pane without
  hiding the right. Navigating to a different top-level task hides the old pair;
  returning restores its last viewed child and layout without starting a runtime.
- Navigation selection and pane focus are separate. Exactly one sidebar row is
  selected; both visible conversations are not simultaneously selected rows.
  Pointer or keyboard focus determines the input target, never the last arriving
  stream. Each Send, Stop, approval, model change and attachment uses the exact
  Session of its own pane. Native output never steals focus or scrolls its peer.
- Reuse the existing transcript, composer, status and icon-button families.
  Show the child's title, purpose, compact parent path, snapshot information when
  applicable, and the shared Hide pane action. Do not add an End action, a new
  global toolbar, extra cards, or a separate input style. The parent keeps its
  existing controls; unsupported child controls remain unavailable.
- Hide pane expands the left pane and returns focus to the invoking child row or
  parent control. Outside clicks do not hide a docked pane. Escape belongs to
  the focused editor/Terminal or top registered overlay; it is not a global
  shortcut to close the conversation. Explicit pane-navigation and Hide pane
  commands provide keyboard access without taking over Terminal shortcuts.
- Each visible transcript advances only its own read cursor when at latest
  content. Reading one pane does not mark the other read; a visible peer already
  at latest content may satisfy its own ordinary reading rule. Hidden panes do
  not acquire read receipts. Preserve parent scroll and Terminal viewport when
  opening, resizing or hiding the child; resize must not restart a runtime.

### Width And Other Workspace Surfaces

Use the workspace's **available content width**, after navigation, to decide
whether two conversations fit. Initial design targets are a 480 CSS-pixel parent
minimum, a 360 CSS-pixel child minimum, and a default 60:40 division clamped to
those minima. Include the shared separator in the width budget. These are layout
proposal values to verify with real composers, not a new compact-mode breakpoint.
The existing compact policy remains authoritative. A keyboard-operable separator
supports bounded resizing; store the preferred ratio locally, never Session state.

When either minimum cannot fit, or the shared policy enters compact mode, show
one conversation at a time with an explicit Parent / Related conversation switch
and the other conversation's attention state. Preserve the pair, drafts, focus
intent and scroll positions; returning to a wide layout restores the split.
Do not shrink both composers until their actions disappear, add horizontal page
scroll, or silently end either conversation. Initial narrow loads use this same
policy rather than briefly mounting an unusable desktop split.

Opening a related conversation from Files, Review, Browser or Computer restores
the parent Chat/Terminal as the left content and remembers the previous workspace
surface. Explicitly opening one of those surfaces keeps its existing navigation
behavior and hides the conversation pair without closing either runtime. Returning
to the pair restores both conversations. Preserve unsaved editor state and resource
identity through the existing surface owner; do not create a third pane or a second
resource/navigation controller in the first delivery.

### Presentation Transitions

The browser owns the parent/child pair, visible surface, focused pane and width;
the backend owns relation identity, capabilities and lifecycle. Store durable
Session identities for restoration, never assume a former runtime attachment is
still live. A stale request may update its exact cached conversation but cannot
replace a newer navigation choice.

| Trigger | Presentation result | Lifecycle effect |
| --- | --- | --- |
| Open an existing child | Resolve parent, show pair, focus child composer or read-only heading | Fresh authoritative read only; no resume |
| Create Side Chat | Keep parent visible; show bounded loading in right pane; settle exact child or explicit failure | Existing creation operation owns admission and reconciliation |
| Select another child | Replace right pane; retain both children’s local view state | No cancel, release or prompt |
| Hide pane / visit another surface | Preserve pair for return; restore appropriate focus | Supervision interest remains; ordinary idle policy still applies |
| Resize wide ↔ narrow | Preserve pair and choose split or single visible conversation | No mutation |
| Child removed or access lost | Show exact unavailable state and a route back; never substitute another child | No automatic recreation |
| Reload / reconnect | Validate saved pair with a bounded authoritative read before controls enable | Reconcile backend state; do not resume merely to render |

## Research Basis

For evidence on when multi-agent orchestration helps, see
[Multi-Agent Workflows: Industry Evidence](multi-agent-workflows-research.md).
Session ownership and workflow dependencies are distinct; Side Chat alone does
not imply a workflow scheduler or dependency graph.


The layout decision is to keep the parent and related conversation visible at
once. Product documentation supports this interaction without proving Farming's
provider capabilities:

- [VS Code: manage sessions](https://code.visualstudio.com/docs/agents/run/sessions/manage-sessions#ask-side-questions)
  explicitly describes Side Chat in a group beside its source, with private
  inherited context. Its multi-chat layout also separates hiding a tab from
  deleting a chat and supports resizable groups. Adopt parallel visibility and
  presentation-only hiding. Its documented Side Chat availability is limited to
  Copilot and Claude in the Agents window; it does not establish Codex support.
  Its per-question child creation and inclusion of in-progress context are not
  this proposal's retained-slot and stable-boundary contract.
- [Zed: Agent panel](https://github.com/zed-industries/zed/blob/main/docs/src/ai/agent-panel.md)
  describes independently running threads with separate context and history and
  project-grouped navigation. This supports identity and navigation separation;
  it does not establish the same Side Chat split interaction.
- [OpenAI desktop app documentation](https://learn.chatgpt.com/docs/app)
  describes supervising parallel work. The retrieved documentation does not
  establish exact Side Chat placement or native-child click behavior. Do not
  claim Codex parity from that source; the same right-pane behavior for both
  Farming child kinds is an explicit product decision here.

## Actions And Retention

| User action | Runtime effect | History and navigation |
| --- | --- | --- |
| Hide pane, back, switch task, collapse parent, dismiss a menu | None | Preserve the conversation and running indicator |
| Stop reply | Cancel this child's current Turn, when supported | Preserve the Session and allow a later message |
| Open ended side chat | Read history without starting a runtime | Resume the same Session only when the user sends a new message |
| Delete side chat | Settle owned runtime cleanup, then delete exact provider history | Remove the related row only after confirmed completion |
| Copy to parent draft | None | Put user-selected content into the parent's ordinary draft, without overwriting an existing draft or sending automatically |

There is no End button. The shared Hide pane control only changes presentation;
it does not cancel, release or delete a Session. Runtime release is
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

The child pane shows "Context through the last completed turn" and an available
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

Opening an existing side chat does not refresh its parent context. The pane
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
during the sixty-second window retains the runtime; expiry makes only an idle runtime eligible for release. Accepted work and pending
interaction continue after disconnect; release rechecks idleness at its owning boundary.

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

The following dependency gates are implementation work, not shipped capability.
The current Conversation Fork path can supply creation primitives, but a fork
alone does not supply retained related membership, a split view or bounded cleanup.
Native-child transcript inspection likewise does not imply prompt support.

| Gate | Scope and owner | Exit evidence / dependency |
| --- | --- | --- |
| 1. Adapter contract | Provider boundary proves stable snapshot, continuation, exact identity and independent release; distinguish active-Turn from idle-only support | Fake-provider contracts plus an isolated real-provider probe; unresolved methods remain disabled |
| 2. Durable related membership | Backend owns parent slot, native-child normalization, capability projection, list deltas and uncertain-operation reconciliation | Concurrent browsers, duplicate history discovery, stale generations and crash boundaries preserve one identity |
| 3. Lifecycle completion | Backend composes creation/resume with idle/disconnect release, parent stop/archive/delete and exact cleanup | Child resources are reclaimed while parent and shared siblings survive; no uncertain mutation is replayed |
| 4. Shared paired view | Workspace navigation composes parent and child transcripts, shared rows, focus routing, width policy and surface restoration | Both Side Chat and native-child entry points pass identical placement, focus and navigation cases; read-only fixtures can be used before creation is enabled |
| 5. Enablement | Complete create/send/retain/reopen path using gates 1–4, then enable only verified adapter capabilities | Common end-to-end suite, three-appearance visual evidence and low-volume real-provider smoke; Terminal entry additionally proves exact identity and non-interruption |

Gate 4 can be developed against deterministic fixtures while backend work proceeds,
but creation must not ship before gate 3. Reuse existing operation, list projection,
transcript and composer owners; do not introduce a second runtime lifecycle. Before
implementation, confirm the layout dimensions with a production-shaped paired
transcript/composer fixture. Provider support is recorded from acceptance evidence,
not inferred from its name or an advertised connection-level Fork method.

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
| Composed UI | Parent and child simultaneously visible; both child kinds open the same right pane; independent input/Stop/approval targeting; hide/reopen, wide–narrow–wide, resource restoration, and running parent plus streaming child, waiting native child, long titles, paged children, unread state, collapse, pins, search, keyboard and touch work in Light/Dark/Paper and compact layouts |
| Cost and scale | Collapsed rows do not load full child transcripts or spawn runtimes; bounded pages/deltas and exact fixture cleanup hold for many parents and native children |

Provider enablement requires low-volume isolated real-provider smokes in addition
to deterministic tests. Source inspection or a successful fork response alone
does not certify continuation, runtime reclamation or Terminal interoperability.
