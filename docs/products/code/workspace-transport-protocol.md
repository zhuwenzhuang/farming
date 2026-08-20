# Workspace Transport Protocol

> Chinese version: [workspace-transport-protocol.zh_cn.md](./workspace-transport-protocol.zh_cn.md)

Status: implemented. The browser product path uses the shared WebSocket for
Workspace File and Language Server control requests. HTTP remains only for the
bounded data-plane cases defined below.

This document defines how Project Files, Git inspection, file watching, and
managed Language Server requests share Farming's existing main WebSocket. It
complements the [Project Files design](./project-files-section-design.md) and
the [Workspace File State Model](./workspace-file-state-model.md). It is a
transport contract, not a requirement to build a general RPC framework or a
general-purpose state-machine library.

## Decision

Farming uses the already negotiated main WebSocket at `/ws` as the single
interactive control connection for Workspace operations. It does not create a
second Files or Language Server WebSocket.

The connection multiplexes independently cancellable, Project-scoped requests,
results, and events. Ordinary source files and bounded structured results may
travel inline. Bulk bytes continue to use authenticated HTTP so a large frame
cannot block Terminal output, ACP events, or interactive Workspace requests on
the WebSocket's ordered byte stream.

Sharing one connection does not make Workspace operations sequential. The
transport correlates requests while the backend executes independent bounded
operations concurrently.

## Goals And Non-goals

The design must:

- remove browser HTTP connection admission and repeated connection setup from
  ordinary file navigation and Language Server work;
- preserve one authenticated, versioned browser protocol and one reconnect
  lifecycle;
- make cancellation, late results, timeout, response loss, and mutation
  uncertainty explicit;
- preserve the filesystem, Workspace File model, Editor Group, and Explorer
  ownership boundaries;
- prevent background Git, search, or Language Server work from starving file
  opens, Terminal interaction, or ACP progress;
- keep every request, response, cache, queue, and payload bounded.

The design does not:

- turn the WebSocket into a bulk file-transfer or media channel;
- replace `WorkspaceFileService`, Git, `rg`, Monaco, or the managed Language
  Server with a new IDE backend;
- make cancellation a correctness mechanism;
- make independent filesystem writers transactional with Farming;
- add a compatibility fallback from WebSocket control requests to HTTP.

## Ownership And Layers

```text
Explorer / Editor / Git panels / Monaco providers
                       |
                       v
       Workspace request clients and file models
       - current intent and model admission
       - same-resource resolve sharing
       - bounded retained snapshots
                       |
                       v
        Main WebSocket request multiplexer (/ws)
       - request correlation and cancellation
       - reconnect classification
       - bounded queues and result dispatch
                       |
                       v
          Project-scoped backend dispatchers
       - schema and access validation
       - fair scheduling and cancellation signal
                       |
          +------------+-------------+
          |                          |
          v                          v
 WorkspaceFileService / Git   Managed Language Server
```

The request multiplexer owns transport lifecycle only. It does not own active
files, preview or pin state, directory expansion, drafts, caches, filesystem
authority, or Language Server lifecycle.

Every Workspace resource is addressed by `rootId` plus a normalized relative
path. `agentId` is not a new file identity and is not used by the Workspace
protocol. The root registry resolves `rootId` to the canonical authorized
Workspace on every backend request; legacy Agent references remain a boundary
compatibility input only while persisted clients are upgraded.

## Transport Boundary

| Operation | Main `/ws` | HTTP data plane |
| --- | --- | --- |
| Workspace root inventory | Existing authoritative state snapshot/delta | No Files endpoint |
| Directory structure and ordinary file metadata/read | Request/result | Oversized or binary body only |
| Directory Git/ignored decoration | Bounded `tree-decorations` request/result | None |
| Save, create, rename, move, delete | Request/result when payload is inline | Oversized upload body only |
| Search | Request/result with bounded matches | None |
| Changes, branch inventory, worktrees, History, blame, line changes | Request/result with paging or truncation | None |
| Branch switch | Request/result with operation identity and version fences | None |
| Exact file watch registration and invalidation | Command/ready/event | None |
| Language Server capability and semantic requests | Request/result/cancel | None |
| Language Server refresh | Existing ordered event | None |
| Static HTML preview session create/delete | Request/result | Preview documents and assets |
| Images, PDFs, audio, binary files, archives | Metadata/request result | Bounded bytes for browser-native viewers |

HTTP transfer responses are still authorized against the same `rootId`, path,
access mode, and content version. A Viewer does not become a second Workspace
authorization path merely because a browser element needs a URL.

The final browser product path must not keep an automatic HTTP fallback for a
WebSocket control operation. A disconnected main WebSocket is a visible
connection failure, not a signal to open parallel HTTP control traffic.

## Protocol Shape

Workspace Files and Language Server remain separate typed domains while sharing
one request broker and one physical connection. This keeps schema validation
and authorization narrow instead of introducing an arbitrary `method` string
that can call any backend function.

Representative envelopes are:

```ts
type WorkspaceRequestMessage = {
  type: 'workspace-request'
  requestId: string
  request: WorkspaceReadRequest | WorkspaceMutationRequest | WorkspaceGitRequest
}

type LanguageServerRequestMessage = {
  type: 'language-server-request'
  requestId: string
  request: ManagedLanguageServerRequest
}

type WorkspaceCancelMessage = {
  type: 'workspace-cancel'
  requestId: string
}

type WorkspaceResultMessage = {
  type: 'workspace-result'
  requestId: string
  ok: boolean
  result?: WorkspaceResult
  error?: WorkspaceProtocolError
}

type LanguageServerResultMessage = {
  type: 'language-server-result'
  requestId: string
  ok: boolean
  result?: unknown
  supported?: boolean
  error?: WorkspaceProtocolError
}
```

`WorkspaceRequest` is a discriminated union. Each operation has its own exact
payload and result schema. The shared protocol validator rejects unknown
operations, unknown fields where ambiguity is unsafe, invalid paths, unbounded
arrays or strings, and payloads above the inline limit before dispatch.
The interactive `tree` operation returns filesystem structure without waiting
for Git. `tree-decorations` accepts the bounded entry paths from that structure
snapshot and returns only Git and ignored decoration for those paths.

Request IDs are unique within a browser connection. A result is admitted only
by the pending record with the same request ID and domain. Unknown, duplicate,
cancelled, or already-settled results are ignored and counted; they never reach
an editor or Explorer owner.

Protocol errors use stable codes such as `NOT_FOUND`, `FORBIDDEN`, `CONFLICT`,
`TOO_LARGE`, `TIMEOUT`, `CANCELLED`, `BUSY`, `UNAVAILABLE`, and `INTERNAL`.
Messages remain actionable human text. A mutation error also declares
`uncertain: true` when the backend cannot prove whether the requested effect
committed.

## Request Lifecycle

A browser request is locally queued, sent, settled, cancelled, disconnected,
or uncertain. These are reasoning states and may be represented with ordinary
records, promises, and abort listeners.

| Current state | Trigger | Required result |
| --- | --- | --- |
| locally queued | compatible protocol hello | Send once if still owned by a live consumer. |
| locally queued | cancellation | Reject locally; send nothing. |
| sent read | result | Settle the matching pending request once. |
| sent read | cancellation | Reject locally and send best-effort `workspace-cancel`. |
| sent read | disconnect | Mark unsent; after compatible reconnect it may be sent again with the same request ID. |
| sent mutation | result | Settle once, preserving conflict or uncertainty. |
| sent mutation | cancellation or disconnect | Mark uncertain; never automatically replay. |
| any settled state | late result | Ignore without changing UI or model state. |

Read replay is safe because it does not mutate filesystem or process state.
Mutation replay is not inferred from a reused request ID. Save, create, rename,
move, delete, preview-session mutation, and branch switch reconcile from an
authoritative file, parent directory, preview inventory, or Git state after an
ambiguous outcome. An explicit retry starts only after reconciliation and uses
the operation identity rules owned by that mutation.

Cancellation releases one consumer. A same-resource resolve shared by multiple
file-open intents sends transport cancellation only when no live consumer still
owns it. Backend cancellation is best effort: unsupported filesystem or Git
work may finish, but its result remains fenced by request ownership and the
latest file-open intent.

## Server Dispatch And Scheduling

The WebSocket message handler validates and schedules work; it never waits for
a long filesystem, Git, or Language Server call before accepting the next
message. Each in-flight request owns an `AbortController`, deadline, operation
classification, and bounded result budget. Connection close aborts all
cancel-safe work and disposes its watch registrations.

Workspace work uses at least two scheduling lanes:

- **interactive**: directory `tree`, file resolve, explicit reload, save and
  direct semantic navigation;
- **background**: `tree-decorations`, search, Git status, History, blame, previews, automatic
  semantic tokens, inlay hints, symbols, and watch-triggered revalidation.

Background work has independent concurrency limits and cannot occupy every
Workspace execution slot. At least one interactive slot remains available.
Limits apply per connection and globally so one browser cannot create
unbounded server work. Same-resource reads are coalesced by the Workspace File
model; the transport scheduler does not create a second cache.

Terminal input and already-available protocol messages remain synchronously
accepted. Workspace scheduling must not delay their dispatch. CPU-heavy or
blocking subprocess operations stay behind existing bounded asynchronous
service methods.

## Payloads And Backpressure

WebSocket ordering means an already-sent large frame cannot be overtaken by a
Terminal or ACP frame. Therefore application priority alone is insufficient;
inline payload size is a protocol boundary.

The protocol hello advertises the effective inline Workspace payload limit.
The initial production value is chosen from measured remote and mobile tests,
with a hard ceiling of 1 MiB per serialized Workspace message. Source reads,
saves, diffs, or structured results that exceed the effective limit do not
enter the main WebSocket as one frame.

An oversized inline read returns bounded metadata plus an authenticated HTTP
transfer descriptor containing the content version. The HTTP response is
bounded by the Workspace file limit and rejects a stale version before sending
bytes. An oversized inline save uses the HTTP upload path with the same
expected-content version and mutation reconciliation contract. Binary and
preview assets use HTTP because browser-native viewers require resource URLs.

Search, History, symbols, references, diagnostics, and similar structured
collections use pagination, count limits, or explicit truncation rather than
silently creating a bulk transfer.

The server never silently drops an RPC result because `bufferedAmount` is high.
It stops admitting background work, keeps a bounded pending-result budget, and
fails new Workspace requests explicitly with `BUSY` before unbounded memory is
created. Persistent transport backpressure becomes a visible connection
failure and follows normal reconnect handling.

## File Reads, Models, And Cache

Moving reads to WebSocket does not change the Workspace File State Model:

- selecting an already open model performs no transport read;
- repeated first opens of one canonical resource share one resolve;
- returning to a retained watched clean model paints immediately without a
  reread; exact watch invalidation removes that retained snapshot, while first
  watch readiness and reconnect perform bounded reconciliation;
- a newer different-file intent revokes the older UI commit lease even when
  backend cancellation loses the race;
- a pinned tab cannot be demoted to preview by another selection;
- a transport result cannot expand an Agent group, move focus, or replay a
  one-shot reveal request.

A successful read returns a content revision such as the existing SHA-1 plus
filesystem metadata. Caches key by canonical `rootId` and normalized path, and
must not cross Workspace ownership boundaries. A file event is an invalidation
hint, not file contents and not proof that a cached version is current.

## Watches And Reconnect

Watch registration moves from Agent identity to Workspace identity. Each
connection declares the exact normalized paths it currently owns for a
`rootId`. The backend maintains one incrementally updated exact-path watcher per
Workspace and partitions ready/error/change events to the owning connection.

Watch readiness includes the accepted path set or its revision. A browser does
not treat readiness as a file change immediately after a successful read. On
reconnect, the browser restores its exact watch sets after protocol hello and
authoritatively revalidates every open watched resource because events may have
been missed. Event bursts coalesce per canonical resource.

Directory expansion does not install recursive Project watching. Directory
snapshots refresh after explicit navigation, a proven mutation, or a bounded
targeted invalidation owned by the Explorer.

## Mutations

Every mutation carries exact `rootId`, normalized path identity, expected
object or content version, and a bounded operation identity where the service
supports deduplication. The backend validates access at the operation level;
placing reads and writes in one envelope does not make a read-only share
writable.

Success invalidates or refreshes affected directory snapshots, retained file
models, working copies, tabs, Git projections, and watch state through their
existing owners. Conflict preserves the draft and returns authoritative
version evidence. Timeout, disconnect, or response loss never becomes an
automatic retry.

Branch switch remains serialized with Project operations and keeps its current
branch/HEAD fences and reconciliation rules. Moving the request to WebSocket
does not weaken those guards.

## Language Server

Language Server capability and semantic requests use the same main connection
and request broker but retain a separate typed protocol and backend dispatcher.
The dispatcher resolves `rootId`, authorizes result locations, applies existing
saved-file and result-size rules, and delegates to the managed Language Server
service.

Monaco cancellation sends `workspace-cancel` for the corresponding Language
Server request when no consumer remains. A superseded automatic request cannot
hold a browser HTTP connection or a Workspace background slot until the
Language Server deadline. Cancellation remains best effort, and editor model,
saved revision, binding, and provider-refresh revision still fence every late
semantic result.

Language Server refresh remains an ordered Project-scoped server event on the
same WebSocket. It is not converted into polling.

## Access And Security

- Authentication and owner/read-only mode come from the negotiated WebSocket.
- Each request resolves `rootId` through the current root registry; a browser
  path never selects an arbitrary server filesystem root.
- Read-only connections may issue read, Git-inspection, watch, preview-viewing,
  and Language Server requests, but not filesystem or branch mutations.
- Exact external-file access remains unavailable to read-only shares and keeps
  its explicit local authorization boundary.
- Symlink escape checks, path normalization, Git-safe arguments, preview CSP,
  and Language Server result filtering remain in their owning services.
- Logs and metrics contain operation, duration, byte counts, queue time,
  outcome, and cancellation reason, but never file contents or full paths.

## Migration Plan

1. Add a connection-owned request broker and typed protocol validation without
   changing `WorkspaceFileService` or the managed Language Server service.
2. Move the critical read path first: tree, ordinary file read, watch identity,
   and Language Server request/cancel. Prove rapid random switching before
   moving more operations.
3. Move bounded search and Git inspection requests, preserving existing
   paging, timeout, and truncation behavior.
4. Move save, create, rename, move, delete, preview control, and branch switch;
   add mutation reconciliation tests before removing their HTTP control paths.
5. Keep only the documented HTTP data-plane routes for raw/oversized/binary
   transfer and preview assets. Remove unused control endpoints and tests that
   would preserve a second product path.

During development, both transports may exist behind explicit test-only
migration seams. A released browser/backend pair uses one control path selected
by protocol version; it does not silently fall back operation by operation.

## Verification And Observability

Protocol and service tests must cover:

- schema rejection, access mode, root resolution, path escape, result
  correlation, duplicate results, and unknown cancellation;
- same-resource request sharing and cancellation of one versus all consumers;
- slow old file followed by fast new files across multiple Projects;
- randomized cold and warm switching across enough files, directories, and
  semantic requests to saturate the background lane;
- a pinned tab remaining pinned and a manually collapsed Agent group remaining
  collapsed across results, watch events, and inventory updates;
- request reordering, cancellation before send, cancellation after send,
  reconnect, server restart, and late completion;
- clean/dirty/saving conflict transitions and uncertain mutation
  reconciliation without automatic replay;
- inline-boundary reads and saves, bounded HTTP transfer handoff,
  truncated structured results, and binary Viewers;
- slow-client backpressure while Terminal input/output and ACP progress remain
  responsive;
- Language Server timeout, cancellation, refresh, malformed or oversized
  result, and saved-model fencing;
- exact watch restoration after reconnect and no recursive Project watcher;
- no ordinary Files or Language Server HTTP control request in the final
  browser acceptance trace.

Measured diagnostics separate queue wait, service execution, serialization,
socket backlog, model admission, and editor paint. Seeded human-like browser
tests preserve their action log, request trace, latency summary, and final
screenshot so a passing assertion cannot hide a visibly stalled editor.

## Rejected Alternatives

- **A second Files WebSocket:** duplicates authentication, liveness, reconnect,
  and protocol-version state without removing TCP head-of-line behavior.
- **HTTP plus aggressive abort:** cancellation may free work but does not remove
  browser connection admission, repeated setup, or split reconnect semantics.
- **All bytes on the main WebSocket:** one large ordered frame can stall
  Terminal, ACP, watches, and semantic results.
- **One global Files state machine:** merges transport, model, Explorer, and
  editor ownership and creates more invalid combinations than it prevents.
- **Automatic HTTP fallback:** creates two product paths and makes failures and
  performance depend on which transport happened to win.
