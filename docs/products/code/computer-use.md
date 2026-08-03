# Farming Computer Use

> Chinese version: [computer-use.zh_cn.md](./computer-use.zh_cn.md)

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
