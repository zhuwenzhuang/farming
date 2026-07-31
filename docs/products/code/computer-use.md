# Farming Computer Use

> Chinese version: [computer-use.zh_cn.md](./computer-use.zh_cn.md)

Computer Use is an optional plugin capability for seeing and operating a full
desktop: screenshots, windows, applications, native dialogs, mouse, keyboard,
and accessibility information. It complements Browser, which remains the
structured webpage and DOM automation capability.

The product model separates the capability from the surface it operates:

```text
Computer Use
└── Desktops
    ├── Local Desktop
    └── Isolated Desktop
```

`Computer Use` is the Agent-facing plugin. A `Desktop` is its user-visible
Resource. Backend routes, persisted compatibility fields, CLI commands, and
Agent tools retain their existing `computer` / `computer_*` names for now;
that compatibility vocabulary is not the product hierarchy.

## Desktop Targets

A Local Desktop means the machine's existing graphical desktop. It is shared
with the user and has one control owner. Farming does not expose this target
until the native driver and its lifecycle are implemented and continuously
verified on the supported host platforms.

The current release implements Isolated Desktop. Each Agent gets an independent
Linux desktop in Docker, so multiple Agents can work in parallel without taking
over the host desktop. The container does not receive the host Docker socket and
does not run Docker-in-Docker.

## Install Isolated Desktop

Farming does not ship a desktop image and never pulls one during normal install,
update, or Server startup. The user explicitly selects **Plugins → Computer
Use → Desktops → Isolated Desktop** and installs it. Farming pulls the
reviewed official `trycua/xfce-cua` image at its pinned digest and verifies the
pinned CUA Driver before enabling the plugin.

On macOS, Docker Desktop is the supported and simplest host for this release.
Install and start it first, reopen Plugins for a fresh Docker probe, then click
**Install isolated desktop**. A local Chromium Browser does not require Docker;
Docker is needed here because CUA operates a complete independent Linux desktop.
Other Docker-compatible runtimes may work when they expose a compatible `docker`
CLI and daemon, but they are not part of the continuously verified product path.

The amd64 image is approximately 472 MB compressed and 1.3 GB unpacked. Docker
stores the image once and shares its layers across Desktop containers. Farming
uses Docker's configured registry path; domestic or private-network acceleration
belongs in the Docker daemon's registry-mirror configuration, not in a hard-coded
third-party Farming URL.

Some older Docker Engines cannot run the image with their default seccomp
profile. Only when the compatibility probe reports that exact problem may the
user explicitly enable Legacy Docker compatibility mode and install again.
Farming never weakens the sandbox silently.

## Ownership And Lifecycle

An Agent owns at most one Isolated Desktop Resource and its exact Docker
container. Different Agents never share the container, desktop session, Viewer
password, Browser profile, or private endpoint.

- Chat/Terminal switches and permission restarts retain the Desktop.
- Stopping or archiving the Agent stops the container but retains the Resource.
- Deleting the Agent removes its exact container and Resource.
- Disabling Computer Use stops Desktops without deleting retained state.
- An active Browser lease must be stopped before its Desktop can be stopped or
  deleted.

Farming verifies container identity and ownership labels before destructive
operations. noVNC is exposed only on loopback and proxied through the
authenticated Farming Server.

## Agent And Human Control

ACP Agents receive the pinned `computer_*` tool catalog when Computer Use is
enabled at their Session boundary. Terminal Agents use the same contract through
`farming computer`.

Control has one explicit owner. While the Agent owns it, the user observes a
read-only live Desktop. **Take control** creates a new interactive Viewer epoch
and blocks Agent actions. **Return to Agent** closes that epoch; before acting
again, the Agent must obtain a fresh desktop, browser, window, or accessibility
observation. Timed-out actions have uncertain outcomes and are never replayed
automatically.
