# Workspace File State Model

> Chinese version: [workspace-file-state-model.zh_cn.md](./workspace-file-state-model.zh_cn.md)

This document defines the correctness and performance model for opening,
viewing, and editing Project files. It is a reasoning and verification model,
not a requirement to implement a general-purpose state-machine framework.

Project Files keeps the implementation close to the layering used by mature
editors: filesystem access is transport-neutral, one resource model owns each
known file, editor groups own preview and pin behavior, and the Explorer owns
directory presentation. Farming adds only the Project-mount dependency and the
browser-side latest-intent admission required by its product model.

## Ownership

Four owners compose the file path:

1. **Workspace access** performs bounded tree, read, write, watch, and Git
   requests. HTTP responses and watch events do not own editor state.
2. **Workspace file models** own resolved snapshots, working copies, one
   pending resolve per resource, and bounded retention of recently used clean
   models. The model key is the canonical workspace plus normalized path.
3. **File-open coordination** owns the latest user intent and the optional
   Project-mount dependency. It may select an existing model immediately, but
   only the current intent may commit navigation, focus, reveal, or preview
   state.
4. **Editor group and Explorer** remain independent projections. The editor
   group owns active, preview, pinned, and tab order; the Explorer owns
   expansion, selection, keyboard focus, directory snapshots, and reveal.

The source Agent on a file intent grants workspace access; it does not grant
permission to activate that Agent's Terminal or Chat, expand its Agent list,
or replace the editor surface. Agent reveal requests are one-shot navigation
events. Each request identity may be consumed once, so a later inventory
refresh or Project-section remount cannot replay an old reveal over the user's
collapsed choice. A reveal request is valid only while its Agent Terminal is
the visible main surface; entering the editor revokes and clears it.

No universal Project Files coordinator owns all four responsibilities. State
that can be derived from an owner is not copied into another owner.

## Resource And Resolve Model

A resource model is absent, resolving, ready, dirty, saving, conflicted, or
failed. These names describe observable transitions; the implementation may
represent them with existing records, promises, and request guards.

| Current state | Trigger | Effect and next state |
| --- | --- | --- |
| absent | open | Start one bounded read and enter resolving. |
| resolving | same-resource open | Join the existing read; merge the latest open target. |
| resolving | different-resource open | Revoke the old UI intent; the shared read may finish but cannot commit that intent. |
| ready | select or reopen | Activate immediately without a transport read or a new editor model. |
| retained watched clean | reopen | Activate immediately, then let watch readiness revalidate asynchronously. |
| retained unwatchable | reopen | Preserve the authoritative read path, while reusing the editor model when possible. |
| ready | watch invalidation | Queue one bounded authoritative reload. |
| dirty | watch invalidation | Preserve the draft and enter conflicted after an authoritative version mismatch. |
| dirty | save | Capture revision and baseline, then enter saving. |
| saving | newer edit | Preserve the newer draft; save completion only commits its captured revision. |
| saving | conflict or uncertain result | Preserve the draft; reconcile from authoritative state before offering retry or overwrite. |
| any | rename, move, or delete | Reconcile resource identity and invalidate affected retained snapshots. |

The resource snapshot cache is not filesystem authority. It exists to make
recent navigation immediate. A fresh successful read is already authoritative,
so the initial watch-ready acknowledgement must not immediately read the same
file again. Reopening a retained watched model may paint it immediately and use
watch readiness to revalidate it. Reconnect readiness revalidates every open
watched file because events may have been missed. A newer invalidation
supersedes an older background reload, and closing or replacing a preview
cancels reload work that no longer has an open-file owner. A clean stale model
may be shown while a bounded reload runs, while a dirty model is never
overwritten by that reload. Global, external, and symbolic-link resources that
do not have this watch contract keep the authoritative read on reopen, though
their editor models may still be retained.

The same physical path can be reached through different access owners, such as
the global root and a mounted Project or two nested Projects. A retained
content snapshot cannot cross that owner boundary: the new owner performs an
authoritative read and establishes its own watch and authorization semantics.
The editor group may reuse the existing tab and Monaco model after that read.

## File-Open Transaction

A file-open intent is selected, resolving, waiting-for-mount, committed,
cancelled, or failed. The following invariants are mandatory:

- one canonical resource has at most one transport resolve in flight;
- a newer different-resource intent cannot be overwritten by an older result;
- repeated same-resource intents share the resolve and the latest cursor,
  focus, view, and reveal target wins;
- the open-file owner, rather than a possibly stale render snapshot, decides
  whether an intent selects an existing model or starts a resolve;
- pinning is monotonic within a transaction and while a tab remains open;
- an already mounted Project does not run a mount mutation on the open path;
- concurrent waiters for one absent Project share its mount mutation, and
  cancelling one waiter does not cancel the shared mutation;
- transport cancellation is an optimization, while the latest-intent lease is
  the final commit guard.

Preview is a creation-time editor-group choice. Selecting an existing pinned
tab never turns it back into preview. Replacing a clean preview removes only
its tab projection; its bounded resource and editor models may remain retained
for fast return.

A pointer double-click is anchored to the file hit by its first click. Opening
that preview may move virtualized rows before the second click. When the native
double-click remains within the bounded time and pointer-distance gesture but
the second hit is blank or a different row, the Explorer suppresses that
displaced hit and commits the pin intent to the first file. Unrelated clicks,
directories, and gestures outside those bounds are not recovered.

A primary pointer gesture is owned by the file row where pointerdown starts.
Virtual scrolling, a completed preview render, or a sticky Agent inventory
change may move content before pointerup, but must not retarget that gesture to
an Agent row or another navigation surface. Row pointer capture preserves this
ownership; controls inside the row keep their own ordinary button behavior.

## Directory And Mutation Model

Directory snapshots stay absent, loading, ready, or failed under the Explorer
owner. Same-directory loads join, workspace changes invalidate old results,
and expansion intent is independent from load completion. Directory caches do
not become file-content models.

Create, save, rename, move, and delete remain version-checked operations. A
timeout or lost response is uncertain, not failed by assumption: reconcile the
file or parent directory and do not blindly replay. Successful mutations
refresh or invalidate affected directory snapshots, retained resource models,
open working copies, tabs, and reveal targets through their existing owners.

## Performance Contract

The implementation must preserve these qualitative fast paths before numeric
budgets are set from measured production data:

- selecting an open model is synchronous and performs no filesystem request;
- returning to a retained watched clean model paints without waiting for the network;
- concurrent first opens of the same resource perform one read;
- switching files reuses the existing editor instance and retained Monaco
  model when present;
- watch bursts coalesce per exact resource and never recursively reload the
  Project;
- retained models are bounded by entry count and approximate content bytes;
- directory, search, Git, preview, and file-content work stay on-demand and
  independently bounded.

Instrumentation should separate user intent, cache lookup, transport read,
optional mount, state commit, and editor paint. Paths and file contents are not
telemetry fields. Numeric latency gates are introduced only after collecting a
representative baseline.

## Recovery And Acceptance

Disconnect and reconnect do not need Terminal-style checkpoint or delta
sequencing. File watch messages are invalidation hints. Reconnect restores
exact watches, the ready handshake schedules authoritative reloads, and current
versions decide whether clean content can update or a dirty draft conflicts.
Failure to verify a cached snapshot during watch recovery preserves the visible
snapshot and leaves connection health as the recovery owner; an actual
filesystem invalidation that cannot be read remains a visible file error.

Tests derive from the transitions above and cover at least:

- single click, double click, and same-file click/double-click overlap;
- slow old file followed by a fast new file, including across Projects;
- pinned-tab selection without preview demotion;
- an Agent list collapsed by the user staying collapsed across file opens and
  Agent inventory refresh, while an explicit later Agent navigation may reveal it;
- a file pointerdown followed by a sticky Agent layout change before pointerup,
  with the file still opening and the Agent remaining inactive;
- a double-click whose first preview moves the row under the pointer, including
  both blank and different-file second hits;
- repeated same-file first open with one transport read;
- preview replacement followed by immediate cached return and asynchronous
  revalidation;
- cancellation of one Project-mount waiter while shared membership completes;
- watch invalidation for clean, dirty, saving, closed, renamed, and deleted
  resources;
- bounded model eviction followed by an ordinary authoritative reopen;
- the same physical file moving from global/external access to a mounted
  Project, with a new authoritative read before the tab is rebound;
- a reproducible seeded cold/warm interaction pass across multiple directories
  and file types, with single and double clicks, tree scrolling and expansion,
  tab dragging, sidebar resizing, a captured action log, and a final screenshot.
