# Farming Desktop MVP

> Chinese version: [desktop-app.zh_cn.md](./desktop-app.zh_cn.md)

Farming Desktop packages the existing Farming Code React interface in Electron. It starts a local
Farming backend before opening the first window, so first launch is immediately usable and never
requires an SSH decision. Remote SSH management is a desktop-only built-in plugin in the existing
Plugins view and can connect the same interface to multiple saved hosts when needed. A normal SSH
profile stores only a name, an OpenSSH Host, and an optional Farming Home. Platform, architecture,
version, port, base path, token, and capabilities are discovered during connection.

## Run

```bash
npm install
npm run desktop
```

Development runs and future macOS packages use the branded desktop icon sources in
`desktop/assets/`; the runtime build copies the PNG beside the Electron main process for the Dock
and window icon.

Open **Plugins → Connections** (or the desktop remote icon) and enter a `~/.ssh/config` Host.
OpenSSH continues to own user, port,
`IdentityFile`, `ProxyJump`, and other advanced settings. Farming Home defaults to
`~/.farming-desktop`; versioned Servers live under `server/<version>/` and the isolated Config
instance lives under `data/`. `BatchMode=yes` requires key or `ssh-agent` authentication.
Linux remotes prefer system glibc 2.28 or newer. Older systems automatically discover a compatible
glibc runtime and can reuse an existing VS Code sysroot configuration.

The connection state machine detects platform and architecture, locates the exact version,
downloads and verifies it remotely, falls back to a locally verified download transferred over
SSH, starts or reuses the daemon, parses a versioned handshake, opens the loopback tunnel, and
freshly reads Browser and Computer capabilities. Development builds may set
`FARMING_DESKTOP_SERVER_VERSION` to a published compatible version for dogfood. A checksum-serving
HTTP(S) mirror with the same release layout may be selected through
`FARMING_DESKTOP_RELEASE_ROOT`; credentials, query parameters, and fragments are rejected.

Legacy Linux discovery first reads `FARMING_SERVER_CUSTOM_GLIBC_LINKER`,
`FARMING_SERVER_CUSTOM_GLIBC_PATH`, and `FARMING_SERVER_PATCHELF_PATH`, then the equivalent
`VSCODE_SERVER_*` variables. Desktop patches only a versioned copy of the verified artifact. It sets
only a short linker alias as the interpreter and supplies the library path at launch. Because
patchelf may legitimately rewrite ELF layout, acceptance is based on reading back the exact
interpreter and running the packaged CLI self-check before the temporary copy atomically replaces
the Server. The daemon also receives the existing `FARMING_NODE_LD` and
`FARMING_NODE_LIBRARY_PATH` compatibility contract so managed child runtimes select or use a
legacy-compatible artifact. The launch-only library path is removed from the Node environment
before system utilities run, then restored only when the packaged Server re-executes itself.
System glibc and VS Code files are never modified.

## Architecture

```text
Packaged React renderer
        |
        | one loopback HTTP/WebSocket origin
        v
Electron desktop gateway
        |
        +-- active backend routing
        +-- owned local Farming backend
        +-- versioned remote Server bootstrap
        +-- native notifications
        |
        v
        +-- local backend
        |
        +-- Connection manager -- system OpenSSH bootstrap + tunnel --> remote Farming backend
```

## Lifecycle State Machine

The Electron main process owns one application lifecycle and one renderer-window lifecycle. Backend
callbacks never call `show`, `reload`, or `loadURL` directly.

| Owner | States | Transition contract |
| --- | --- | --- |
| Application | `starting → running → stopping → stopped` | The Gateway, IPC, and stores must exist before `running`. Any quit or terminal startup failure enters `stopping` once. Connection and Gateway cleanup share one promise; only its completion enters `stopped` and exits Electron. |
| Main window | `absent ↔ loading → ready`, or `loading → failed` | Opening increments a window generation. Every navigation captures that generation and the current renderer-route revision. Only the current generation may become ready, show, focus, fail startup, or schedule another navigation. |
| Local backend | `idle → starting → ready → stopping → stopped`, or `starting → failed` | Concurrent starts share one promise and stop is idempotent. The app does not open a window until the local daemon has published a valid port, base path, and token. Desktop shutdown owns its bounded stop. |

Backend activation, saved-backend reconnection, active-backend removal, and notification navigation
invalidate the renderer route by incrementing its revision. If the window is ready, one navigation
effect is queued after the current IPC action completes; same-turn invalidations are batched into its
newest revision. If the window is already loading, further invalidations are coalesced. Completion for an
obsolete revision retries with the newest requested route; completion for a closed window or an
application in `stopping` is ignored. This prevents both stale startup data and competing reloads.

After `stopping` begins, the lifecycle rejects new windows and route invalidations and suppresses
state broadcasts and late UI effects. Shutdown is idempotent even when multiple macOS quit events
arrive.

The renderer has no Node.js integration and never receives the upstream token. The discovered
token exists only in the authenticated SSH handshake and Electron main-process memory. A random
HttpOnly desktop-session cookie protects the gateway, which injects bearer authentication and
forwards REST and WebSocket traffic. Electron executes only packaged local application assets.

Connection state is isolated by stable backend ID and progresses through `disconnected`,
`connecting`, `ready`, or `error`. Each attempt increments a generation so stale completion cannot
overwrite a newer action. A connection becomes ready only after `/api/auth/status` succeeds and
fresh capability reads finish. Switching connects the target before updating the active ID,
closing renderer WebSockets, and reloading the UI.

## Security Boundary

- SSH is executed with argument arrays and honors OpenSSH configuration; host-key checks stay on.
- Downloads are verified against the selected Release SHA-256 manifest. If the remote cannot reach
  it, the desktop verifies the same artifact and streams it over authenticated SSH. The remote writes
  only to a per-attempt temporary file, rechecks byte count and SHA-256, and promotes it atomically;
  interruption removes that temporary file and cannot replace an installed Server.
- A legacy compatibility linker, library path, and patchelf must exist. The private linker alias,
  patched interpreter, and executable self-check must all validate.
- Discovered Farming tokens are not persisted in profiles or exposed to the renderer.
- The renderer uses context isolation, sandboxing, and no Node.js integration.
- IPC and microphone access are limited to the exact loopback gateway main frame.
- Browser and Computer remote content receives no desktop preload bridge.

## MVP Limits

The MVP does not support interactive SSH passwords, Windows remotes, automatic sysroot builds, authenticated enterprise mirrors, or
inactive-backend notifications. The bootstrap handshake is protocol version 1. Missing handshakes,
invalid ports, and unavailable exact-version artifacts fail explicitly. Microphone capture is local,
while speech recognition still uses the existing browser implementation.

## Verification

Focused coverage validates profile normalization, handshake parsing, SSH option rejection, host-key
policy, renderer token redaction, bearer/base-path routing, lifecycle generation/revision guards, and rejection of renderer artifacts built
for a backend base path. The Desktop build always emits root-relative renderer assets. Before opening
a window, main validates every entry script, stylesheet, and module preload; the window remains hidden
until either the application shell or its visible error fallback renders. Smoke asserts those assets
return success, visible first-screen content exists, and the renderer emits no uncaught error.
Product-shaped smoke should also cover first installation on a real remote, local-transfer fallback,
version reuse, backend switching during a live WebSocket, tunnel loss, and notification click routing.
