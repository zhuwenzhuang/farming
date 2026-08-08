# Language Server

> Chinese version: [language-server.zh_cn.md](./language-server.zh_cn.md)

User guide: [Language Server (experimental)](https://zhuwenzhuang.github.io/farming/en/experimental/language-server).
This document remains the authoritative backend, lifecycle, and acceptance contract.

Status: managed, viewing-oriented capability.

## Product Boundary

Farming may start a matching Language Server on the backend that owns the
Project. The editor uses it for code understanding; users do not configure
transport sockets or maintain a separate Language Server workspace in Farming.

```text
Farming editor
      |
      | authenticated, Project-scoped requests
      v
Farming backend on the Project host
      |
      | Language Server Protocol
      v
managed or system language server
```

The backend owns server discovery, Project-root selection, process lifecycle,
request deadlines, and result authorization. One compatible server may be
reused within the same Config, language, and Project-root boundary. Different
Config instances do not share mutable Language Server state.

## File And Result Authority

Requests are authorized against the exact Project root. Symlink escapes and
result locations outside that Project are rejected.

Semantic results describe the saved file on disk. When the Farming editor has
an unsaved draft, actions that could present stale cross-file meaning are
withheld rather than pretending the disk result describes the draft.

## Capabilities

The viewing-oriented surface may include hover, definitions, references,
implementations, document highlights, semantic tokens, inlay hints, symbols,
call/type hierarchy, and diagnostics when the active server supports them.
Availability is derived from a real initialized connection, not from the
built-in registry alone.

Document highlights distinguish textual, read, and write occurrences using
the server's symbol meaning rather than a plain text search. Semantic tokens
use the legend returned during static or dynamic LSP capability registration;
the frontend remaps that legend to a stable Monaco legend before applying the
token stream. Unknown server-specific token types retain a neutral variable
style, and unknown modifiers are ignored. Inlay hints are requested only for
the editor's visible range and preserve parameter/type kind, label parts,
tooltips, and padding without treating server commands or edits as authorized
actions.

These three reading aids describe only a saved model. Editing, replacing,
disposing, or switching the model fences pending responses and clears stale
presentation. Saving a current draft re-enables the providers. Highlight and
inlay result counts and full-document semantic token payloads are bounded;
oversized or malformed server results fail explicitly rather than being
silently truncated into misleading code meaning.

When a server sends `workspace/semanticTokens/refresh` or
`workspace/inlayHint/refresh`, the managed client acknowledges the request and
publishes an ordered Project-scoped refresh revision to connected Farming
pages. A new `textDocument/publishDiagnostics` snapshot is also an authoritative
signal that the server has re-analysed an open document, so it invalidates these
saved-file providers even when a server does not emit the optional workspace
refresh requests. JDTLS additionally emits `language/status` with
`ServiceReady` after project import; the managed client uses that one-time
authoritative milestone to invalidate providers again because earlier document
diagnostics can arrive before project-wide semantic results are ready. A page
accepts only a newer revision from the current backend epoch and only when that
Project still owns a clean bound model. The manager retains the latest revision
for each active Project and provider and replays that snapshot after WebSocket
protocol negotiation, so a page reload or reconnect cannot miss a one-time
readiness milestone. If the matching editor model is not bound yet, the page
holds the revision until that clean model exists. Dirty or unrelated models do
not issue saved-file semantic requests. This event path is also the authoritative
cold-start recovery mechanism; the frontend must not substitute polling or file
switching for real server state signals.

An Inlay Hints request that times out before the server is ready becomes a
transient empty Monaco result so the provider remains subscribed to later
refresh events. The next authoritative refresh retries the request; malformed,
oversized, or otherwise non-transient results still fail explicitly.

Call and type hierarchy use a prepared root and lazily request children for
each expanded node. A node distinguishes not requested, loading, loaded-empty,
loaded, and failed children. Collapsing a loading node does not let a late
response reopen it; loaded children remain cached for re-expansion. Changing
hierarchy direction fences older responses, while a node failure stays local
and can be retried without rebuilding the whole tree. Opening a hierarchy
result keeps that tree and its loaded branches available across Project-local
file navigation; an unrelated file or Project change closes the old context.
The tree follows standard keyboard navigation: Up/Down move among visible
items, Left/Right collapse or expand, and Enter opens the selected location.

Document symbols preserve the hierarchy returned by the server. The first
level is visible initially, nested containers are locally collapsible, and
expanding or collapsing them does not issue another Language Server request.

Definition and implementation requests navigate directly when the server
returns one location; multiple locations and references remain visible in the
shared navigation tool window with compact parent-directory context, filenames,
and line numbers. The tool window is a non-overlapping adaptive dock: it uses
the right side of a wide editor and the bottom of a narrow editor. Opening one
of its results keeps the current hierarchy or result set available for related
Project-local navigation. These actions issue requests from the current saved
model binding, and changing the active file fences a late result.

Workspace symbol search requires a non-blank query. Searching from a saved
file starts that file's matching managed server when needed, normalizes the
LSP workspace-symbol location before navigation, and bounds one rendered
result set to 500 entries with explicit truncation feedback.

Diagnostics are applied only while the requesting model, saved revision, and
binding are still current. Editing, replacing, or disposing the model
invalidates pending diagnostic responses, so a late response cannot restore
markers that the newer editor state cleared.

## Lifecycle And Failure

A managed server is absent, starting, ready, stopping, or failed. Concurrent
starts for the same ownership boundary join one transition. An exited or failed
server is removed from active state; a later explicit request may start it
again. Requests and shutdown are bounded, and failures remain visible instead
of silently switching to another provider.

The backend prefers a matching Language Server executable already available on
the Project host. When clangd or JDTLS is unavailable, Farming may install its
repository-pinned runtime version on demand. It does not resolve mutable
`latest` archives: every managed download has a repository-pinned URL and
SHA-256 digest, and is verified before extraction or execution. Missing or
mismatched integrity metadata fails with an actionable error.

## Acceptance Criteria

Verification must cover Project-root discovery, saved-file semantics, result
filtering, process reuse and restart, concurrent requests, explicit failure,
Remote SSH ownership, static and dynamic capability registration, semantic
legend mapping, visible-range inlay requests, ordered Project-scoped provider
refresh, dirty-model refresh rejection, stale-result fencing, and representative
real language servers.
