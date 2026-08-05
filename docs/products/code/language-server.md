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
implementations, symbols, call/type hierarchy, and diagnostics when the active
server supports them. Availability is derived from a real initialized
connection, not from the built-in registry alone.

## Lifecycle And Failure

A managed server is absent, starting, ready, stopping, or failed. Concurrent
starts for the same ownership boundary join one transition. An exited or failed
server is removed from active state; a later explicit request may start it
again. Requests and shutdown are bounded, and failures remain visible instead
of silently switching to another provider.

## Acceptance Criteria

Verification must cover Project-root discovery, saved-file semantics, result
filtering, process reuse and restart, concurrent requests, explicit failure,
Remote SSH ownership, and representative real language servers.
