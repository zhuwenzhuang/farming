# Share Access Model

> Chinese version: [share-access-model.zh_cn.md](./share-access-model.zh_cn.md)

This document defines the authorization and interaction contract for Farming Code
sharing.

## Product Contract

The share popover exposes different capabilities deliberately:

| Current visitor | Copied link | QR code | Passphrase |
| --- | --- | --- | --- |
| Owner | Read-only | Full control | Full control |
| Read-only visitor | Read-only | Read-only | Not disclosed |

The UI must state the QR permission and expiry directly below the QR code in muted
text. The copy confirmation must say that the current-page link is read-only,
cannot modify the workspace, and expires with the countdown. The owner passphrase
area is a clickable button that copies a full-control URL while preserving the
segmented passphrase line wrapping. It must carry a separate warning that it grants
full control until the instance credential changes; it does not inherit the QR
countdown.

Sharing requires token authentication. If authentication is disabled, Farming
must refuse to present a share result because a recipient could bypass any
restricted link and open the unprotected instance directly.

## Authoritative State

The backend assigns every authenticated HTTP request and WebSocket connection one
access mode:

- `owner`: the instance credential; read and mutation are allowed.
- `read-only`: a signed capability; observation and further read-only sharing are
  allowed, while other mutation is rejected.
- `none`: no valid credential; access is rejected.

The frontend presents these modes but is never the authorization boundary. A
read-only session keeps a visible workspace-level read-only indicator after the
share popover closes.

## Share Creation

An owner share request creates:

- a signed read-only capability used by the automatically copied long URL;
- a one-time QR ticket carrying the owner credential;
- the owner passphrase for explicit full-control access.

A read-only visitor may create a delegated share. Its response contains only:

- a signed read-only capability used by the copied long URL;
- a one-time QR ticket carrying that same read-only capability.

The delegated response must not contain the owner passphrase or any owner
credential. Its expiry is capped by the parent read-only capability, so repeated
re-sharing cannot extend access.

Share tickets and newly issued read-only capabilities have a maximum lifetime of
five minutes. A ticket is single-use. Earlier capabilities keep their own original
expiry. The owner passphrase is the instance credential and remains valid until it
is changed or rotated.

## Redemption

Redeeming a QR short link consumes its ticket and stores exactly the ticket's
credential in an HTTP-only cookie. Consequently, an owner-created QR grants full
control, while a read-only visitor's QR remains read-only.

The copied long URL always carries a read-only query capability. On first use the
backend moves it into an HTTP-only cookie and removes it from the URL before the
application loads, reducing address-bar, history, and referrer exposure.

New HTTP requests and WebSocket handshakes are admitted only while a capability is
valid. Existing WebSocket connections retain their admission until disconnect.

## Read-Only Enforcement

For `read-only` HTTP access, `GET`, `HEAD`, and `OPTIONS` are admitted. The only
mutation exceptions are creating or revoking a share ticket, and creation can issue
only read-only capabilities for a read-only caller. All other methods return `403`
before their route handlers run.

The primary WebSocket admits only protocol negotiation, health/state refresh,
view focus, and file-watch subscription messages. Agent start, terminal or Chat
input, permission responses, interruption, resize, clear, archive, and restart
messages are rejected before reaching lifecycle or session owners.

The frontend queues ordinary client messages until the WebSocket handshake confirms
the access mode. It flushes them for an owner and only flushes view-safe messages for
a read-only visitor. Automatic Terminal `resize-agent` messages are silently skipped
on read-only pages so the initial layout does not surface a non-user permission error;
the backend continues to reject that message as the security boundary.

Browser Viewer connections may receive frames but their input and resize messages
are ignored. Computer Viewer connections are rejected because its bidirectional
RFB transport cannot provide a server-verifiable view-only boundary.

## Failure And Recovery

- Invalid, tampered, or expired capabilities receive the normal authentication
  failure and cannot open new WebSocket connections.
- Read-only mutation attempts fail explicitly with `403` or a WebSocket error and
  are not replayed by the backend.
- When authentication is disabled, share creation fails explicitly.
- A failed delegated share never falls back to owner access or a longer expiry.

## Acceptance Criteria

- The automatically copied URL is always read-only.
- Owner QR and passphrase access remain full-control and are labeled as such.
- A read-only visitor can re-share, but receives only a read-only URL and read-only
  QR, with no owner passphrase or owner token.
- Delegated shares never outlive their parent capability.
- Direct HTTP and WebSocket mutation attempts with a read-only capability produce
  no workspace, Agent, terminal, configuration, Browser, or Computer side effect.
- Owner HTTP and WebSocket behavior remains unchanged.
- Read-only recipients continue to receive current state, file-watch updates,
  terminal output, transcripts, and Browser frames.
