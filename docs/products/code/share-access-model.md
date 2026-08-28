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
cannot modify the workspace, and expires with the countdown. Direct Chat and File
copy confirmations appear next to the activated share control and state the exact
expiry time returned by the backend. The owner passphrase
area is a clickable button that copies a full-control URL while preserving the
segmented passphrase line wrapping. It must carry a separate warning that it grants
full control until the instance credential changes; it does not inherit the QR
countdown.

Sharing requires token authentication. If authentication is disabled, Farming
must refuse to present a share result because a recipient could bypass any
restricted link and open the unprotected instance directly.

Share responses that contain credentials are never cacheable. Farming derives
links from the direct request origin and does not trust forwarded origin headers.
An HTTPS reverse proxy or another deployment whose public origin differs from the
request origin must set `FARMING_PUBLIC_ORIGIN` to its exact HTTP(S) origin.

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

Chat answer actions and the File Viewer expose a direct copy action for this same
read-only long URL. A Chat action freezes the selected durable Turn identity rather
than the surrounding viewport. A File action freezes the current file identity,
Editor or Diff view, and the current reading line and column. Creating a direct link
also creates a QR ticket as part of the shared backend response; because the direct
action does not display that ticket, the client revokes it after copying the long URL.

Opening a contextual link resolves the exact location before applying a bounded
fallback. Chat loads older transcript pages while the selected Turn may still exist,
then falls back to the latest Chat position if it is unavailable. File positions clamp
to the current file bounds. If a shared file remains unavailable after bounded Project
inventory reconciliation, Farming opens its nearest available parent folder. If the
Agent or Project itself cannot be resolved, Farming keeps the default workspace open
and reports the failed location. A location fallback never changes the link's
read-only access mode. The frontend captures the contextual location once at startup
and immediately removes its query fields from the visible URL while retaining the
credential. Reload and restart therefore use current workspace state instead of
replaying a stale location.

An owner startup URL carries the instance token so the entry assets can load. The
frontend keeps that token in the visible URL so reloads, copied URLs, and installed
app handoffs retain owner access. The HTTP-only cookie remains an alternate
authenticated transport, but does not replace the URL credential.

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
Workspace file reads, search, Git inspection, and file-watch messages remain
available, while mutation controls are absent and opening an existing Agent file
must not trigger a Project-mount mutation.
Language Server requests are also withheld and rejected: even a semantic read
may install a managed runtime, create caches, or start a backend process, which
would violate the read-only capability's no-side-effect boundary.
Read-only Browser capability probes do not persist a discovered default, and
read-only update checks ignore forced refresh while projecting recovery state
without committing it or preparing installation directories. Static preview
capacity and deletion are isolated by authority and read-only credential, so a
viewer cannot evict or delete Owner or another viewer sessions.

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
- Contextual Chat and File copy actions include the selected Turn or current file
  reading position and show the read-only-link copy confirmation and exact expiry
  time next to the activated share control.
- Out-of-order direct-share responses cannot replace the clipboard result of a newer
  share action.
- Owner QR and passphrase access remain full-control and are labeled as such.
- An owner startup URL retains its token through reload and supplies the same
  token to an installed app's start URL.
- A contextual location is applied only by its first page load; the visible URL
  retains the credential but cannot replay that location after reload or restart.
- A read-only visitor can re-share, but receives only a read-only URL and read-only
  QR, with no owner passphrase or owner token.
- Delegated shares never outlive their parent capability.
- Direct HTTP and WebSocket mutation attempts with a read-only capability produce
  no workspace, Agent, terminal, configuration, Browser, or Computer side effect.
- Owner HTTP and WebSocket behavior remains unchanged.
- Read-only recipients continue to receive current state, file-watch updates,
  terminal output, transcripts, and Browser frames.
