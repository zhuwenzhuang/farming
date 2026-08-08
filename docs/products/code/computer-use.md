# Farming Computer Use

> Chinese version: [computer-use.zh_cn.md](./computer-use.zh_cn.md)

User guide: [Computer Use (experimental)](https://zhuwenzhuang.github.io/farming/en/experimental/computer-use).
This document remains the lifecycle, ownership, isolation, and acceptance contract.

Computer Use is an optional capability for seeing and operating a full desktop:
applications, native dialogs, mouse, keyboard, screenshots, and accessibility
information. Browser remains the structured webpage and DOM capability.

## Desktop Targets

- **Local Desktop** means the host's existing graphical desktop and requires a
  continuously verified native driver and single control owner.
- **Isolated Desktop** gives an Agent an independent Linux desktop and is the
  supported target when the required container runtime has been explicitly
  prepared.

Farming shows only targets backed by a working, verified runtime. Missing
prerequisites remain explicit rather than producing a low-quality fallback.

## Ownership And Lifecycle

An Agent owns at most one Isolated Desktop and its exact runtime. Different
Agents do not share the desktop Session, credentials, profile, or private
endpoint.

- Chat/Terminal and permission replacement retain the Desktop.
- Stopping or archiving the Agent stops the runtime but retains the Resource.
- Deleting the Agent removes the exact Desktop it owns.
- A Browser using the Desktop must release its lease before the Desktop stops.

Farming verifies exact ownership before destructive actions. The Viewer is
served through the authenticated Farming boundary rather than exposed as a
public desktop endpoint.

The Resource owns one driver session identity and desktop capture scope. Inside
the Resource's serialized action queue, Farming idempotently refreshes that
exact session before every session-bound tool call, including an explicit
`start_session`. Caller-supplied session identities and capture scopes cannot
replace the Resource-owned values. If the preflight refresh for another tool
fails, that requested tool has not been sent. Farming exposes this fact through
the HTTP and Agent CLI error envelope. A transient refresh transport failure is
retryable; deterministic runtime failures remain explicit. An explicit
`start_session` is itself the refresh, so its delivery may be uncertain, but
the operation is idempotent and safe to retry after a transient failure.
Queue wait, refresh, the Driver call, and screenshot extraction share one
request deadline shorter than the Agent HTTP transport timeout. Expiry before
the original tool is sent is reported with `actionStarted: false`; expiry after
a mutation starts follows the uncertain-outcome contract below.

## Agent And Human Control

ACP Agents use Computer tools; Terminal Agents use the same capability through
`farming computer`.

Control has one owner. While the Agent owns control, the user observes. **Take
control** blocks Agent actions and gives the user an interactive Viewer.
**Return to Agent** ends that control epoch; the Agent must observe fresh state
before acting again.

A timed-out action has an uncertain outcome. Farming observes and reconciles
before any retry and never replays the action automatically.

## Safety And Acceptance

The isolated Desktop must not receive the host container socket or another
Agent's mutable state. Verification covers installation prerequisites, exact
ownership, Browser leases, stop/delete, restart, human handoff, uncertain
actions, authentication, and parallel isolated Desktops.
