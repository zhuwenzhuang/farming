# Farming Desktop

> Chinese version: [desktop-app.zh_cn.md](./desktop-app.zh_cn.md)

User guide: [Farming Desktop (experimental)](https://zhuwenzhuang.github.io/farming/en/experimental/desktop).
This document remains the architecture, credential, lifecycle, and recovery contract.

Farming Desktop packages the existing Farming Code interface in Electron. It
starts a local Farming backend by default and can connect the same interface to
saved remote Farming backends over OpenSSH.

## Product Boundary

Desktop owns only backend selection, native window lifecycle, operating-system
integration, and remote connection bootstrap. Agent, Project, Session,
Terminal, Files, Chat, plugin, and Review behavior remain in the shared Farming
frontend and backend.

A feature that neither selects a backend nor requires a native operating-system
capability must not gain a Desktop-specific implementation.

## Architecture

```text
Packaged Farming Code renderer
            |
            | one authenticated loopback origin
            v
Electron Desktop gateway
            |
            +-- owned local Farming backend
            +-- saved remote connections through OpenSSH tunnels
            +-- native window and notification integration
```

The renderer never receives upstream backend tokens or Node.js access. The
Desktop gateway keeps backend credentials in the main process, authenticates
the local renderer, and forwards HTTP and WebSocket traffic to the selected
backend. Remote content does not receive a Desktop preload bridge.

## Local And Remote Backends

First launch opens the local backend without requiring an SSH decision. Remote
connections are optional profiles based on the user's OpenSSH configuration.
Platform, architecture, version, endpoint, authentication, and capabilities are
discovered during connection rather than copied into user-maintained profile
fields.

Desktop may install or reuse a version-compatible remote Server. Downloads and
transfers are bounded, integrity-checked, cancellable, and published only after
verification. Legacy Linux compatibility must use a private verified runtime
without modifying system or editor-owned files.

Switching backends is atomic from the renderer's perspective: the target must
be ready before it becomes active, and stale completion from an older attempt
cannot replace a newer selection.

## Lifecycle

The main process owns application, window, local-backend, and connection
lifecycles. Each asynchronous transition has one owner and generation. Quit,
cancel, profile change, connection replacement, and startup failure revoke only
the exact resources they own.

The first window must present bounded startup progress or an actionable error;
it must not remain blank. An uncertain startup or stop result is reconciled from
the backend's authoritative handshake and process identity before another
mutation is attempted.

After shutdown begins, Desktop rejects new windows, connections, and navigation
effects. Cleanup is idempotent and completes before the application exits.

## Security Boundary

- OpenSSH configuration and host-key verification remain authoritative.
- Downloaded Server artifacts are verified before use and never promoted from a
  partial transfer.
- Discovered backend tokens are not persisted in connection profiles or exposed
  to the renderer.
- The renderer uses context isolation, sandboxing, and no Node.js integration.
- Native IPC and device permissions are limited to the authenticated local
  application origin.

## Failure And Recovery

Connection cancellation, tunnel loss, incompatible protocol, missing artifact,
failed local startup, and failed backend switch remain visible and bounded.
Desktop must preserve the last known good backend until a replacement is proven
ready. Relaunch reconciles saved profiles and local ownership without requiring
a modal backend choice.

## Acceptance Criteria

Verification must cover first local launch, cancel and retry, remote enrollment,
artifact transfer, legacy Linux compatibility, backend switching, tunnel loss,
quit during startup, relaunch, credential isolation, packaged assets, and the
ordinary Farming user stories through the real Desktop UI.
