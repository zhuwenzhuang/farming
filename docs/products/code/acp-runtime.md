# ACP Runtime

> Chinese version: [acp-runtime.zh_cn.md](./acp-runtime.zh_cn.md)

Farming uses Agent Client Protocol for structured Chat with supported coding
agents. The backend owns runtime lifecycle, provider sessions, ordered Chat
state, configuration, permissions, and recovery. Browser interfaces present
that authoritative state and do not reconstruct it from prose or terminal
output.

## Provider Boundary

Provider-specific executable discovery, environment, adapter patches, optional
methods, and history behavior belong in Provider Adapters. Generic lifecycle and
Chat code use negotiated ACP capabilities and must not infer support from a
provider name.

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

Farming may support standard ACP session, prompt, cancellation, configuration,
authentication, elicitation, terminal, media, plan, and fork capabilities when
the live Agent advertises them. Provider extensions must be versioned,
negotiated, and confined to the adapter boundary.

## Runtime Ownership

Each Config instance has one ACP Runtime Host. The Farming Server is a
replaceable controller; the Host owns live provider connections, active
operations, ordered reducers, and process identities. A compatible Server
restart reconnects to the Host and restores its authoritative checkpoint and
deltas instead of restarting healthy sessions.

ACP has no fixed Agent, Session, process, thread, or concurrency cap. Resource
protection must come from bounded queues, payloads, caches, and backpressure,
not from an arbitrary limit on how many Agents may exist.

Provider runtimes may be shared only when the provider supports independent
multi-Session operation. A shared pool is keyed by Provider and canonical Agent
Home. Every Session still owns its own workspace, provider Session id,
configuration, permissions, identity, MCP scope, active Turn, and recovery
state. Closing or deleting one Session must not stop unrelated Sessions in the
same pool. A pooled runtime failure reconciles every affected Session and never
replays an uncertain Prompt.

Browser and Computer capabilities use the instance-exact Farming CLI and
shared backend services rather than one capability subprocess per Agent.
Separate unguessable credentials are scoped to the exact Agent, capability
runtime epoch, and authorized workspace, and are revalidated against current
backend ownership on every request. Farming-owned capability MCP entries are
not injected into ACP Sessions; provider and user MCP configuration remains a
private Session input.

## Session Identity And Configuration

The stable identity of an ACP conversation combines Provider, canonical Agent
Home, provider Session id, and workspace scope. Additional directories and MCP
definitions are private Session inputs and must survive reconnect, restart, and
runtime replacement without being exposed as ordinary browser state.

Configuration has two authorities:

- without an explicit user override, the loaded Provider Session and selected
  Agent Home supply defaults;
- after a user change is confirmed, Farming persists only that explicit
  override and reapplies it after the Provider Session is loaded.

Overrides are matched by stable option identity, never by display labels. If a
saved option or value is no longer supported, Farming keeps the Provider's
current value, drops only the incompatible override, and reports a recovery
warning without making the Session unusable. A transport failure is not proof
that an override is permanently incompatible.

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

Queued follow-ups remain editable and discardable until admission begins.
Negotiated live Steer remains inside its owning Turn; providers without that
capability use the visible queue.

## Transcript Protocol

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

Provider replay is authoritative. Local checkpoints accelerate projection and
preserve reset fences, but cannot replace a full load unless the provider can
prove freshness. An uncertain Prompt leaves the checkpoint dirty.

Opening a Chat should show its shell immediately and obtain the first settled
transcript in tens of milliseconds when a valid prepared checkpoint exists.
Preparation happens in the backend only after an explicit interest signal and
a quiet period. It is cancellable, revision-fenced, and bounded by entry count,
response size, total cache size, and active work. Failure or eviction falls back
to the same authoritative on-demand read.

The first settled ACP transcript response contains only the five newest Turns.
Older Turns load in bounded pages as the reader moves upward, so opening a long
Chat does not make its full Markdown and tool history part of first paint.

The browser keeps heavyweight transcript trees only for visible Chats. Inactive
Chats retain small navigation anchors and reload from the backend checkpoint
when revisited. Reading position is anchored to a stable Turn or process item,
not to raw pixels alone, so reload and pagination can restore the same context
without keeping every transcript in frontend memory.

## Lifecycle And Recovery

The meaningful Session states are connecting, idle, working, waiting for user
input, interrupting, recoverable error, and terminal failure. Idle is an
ordinary live state. A Session remains live until the user stops, archives,
deletes, or switches it, or until an exact runtime failure is proven.

Unexpected adapter or Host loss ends in explicit recovery or failure. Recovery
must prove old-process ownership, restore the same Provider Session and private
scope, reload authoritative history, and preserve explicit configuration
overrides. A Turn active at disconnect ends as failed or uncertain and is never
silently replayed.

Chat/Terminal switching is a real runtime replacement that preserves the same
provider conversation when resumability is proven. Switching is rejected while
a Turn is active. If the target runtime fails to start, Farming restores the
original runtime and reports the failed switch.

Conversation Fork is available only when the adapter contract and live
capability both support it. The source revision, child identity, ownership, and
cleanup responsibility must be exact. Failure before the child is durable is
visible and must not silently create a different fork.

## Presentation Contract

Chat shows the ordered conversation, one compact live activity signal for the
current Turn, and reversible structured evidence. Completed reasoning and tool
details do not remain as overlapping default summaries. Disclosure controls
keep stable layout slots and become visually prominent on hover or keyboard
focus.

A fresh Chat shows the stable empty-conversation state while its Session
connects. Session startup is not an active Turn and must not enable Steer or
replace the empty state with transient startup copy. Explicit history restores
may show bounded synchronization feedback until their first authoritative
transcript settles.

Live transcript revisions coalesce behind an in-flight read instead of
repeatedly cancelling it, so sustained update streams make visible progress
without waiting for a quiet period. Newly visible intermediate messages use a
short, bounded reveal; multiple arrivals reveal in parallel and reduced-motion
preferences disable the effect. Expanded reasoning omits a leading line that
already serves as its folded title.

The latest live answer mounts its first authoritative text in full. While its
Agent remains active, later prefix-extending revisions drain only their new
suffix at a bounded reading cadence. Navigation, an inactive pane, completion,
recovery, reduced motion, a hidden page, or a non-prefix correction immediately
publishes the current authoritative result instead of replaying buffered text.

The Composer preserves drafts, IME behavior, attachments, queue/steer controls,
permissions, and negotiated configuration. Reload may restore an unresolved
submission as a visible item requiring reconciliation, but never resubmits it
automatically.

## Acceptance Criteria

Every supported provider must pass the same provider-neutral verification for
the contracts it implements. Verification must cover provider capability
negotiation, exact identity and Agent Home isolation, configuration fallback,
ordered mutations, uncertain outcomes, Server and Host restart,
checkpoint/delta gaps, reading-position restore, Chat/Terminal switching,
Fork, media and tool evidence, and large multi-Agent workloads. Scale tests
must measure process count, memory, wire volume, browser render work, and
navigation latency without imposing a fixed concurrency ceiling.
