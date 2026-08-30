# Config Instance Isolation

> Chinese version: [config-instance-isolation.zh_cn.md](./config-instance-isolation.zh_cn.md)

This document defines how several Farming instances may share one machine
without confusing Farming-owned state or claiming exclusive ownership of
external developer resources.

## Instance Identity

The canonical Config directory is the identity of one Farming instance.
Equivalent paths, including symlinked paths, must resolve to the same identity.
Two live Servers may use different Config identities; two Servers must not own
the same Config identity at the same time.

Resources follow these ownership boundaries:

| Resource | Owner |
| --- | --- |
| Settings, authentication, session metadata, runtime records, and managed caches | One Config instance |
| Farming-owned sockets, process namespaces, Browser profiles, and Computer resources | One Config instance |
| Farming child processes | The exact Config instance and exact operating-system process identity |
| Projects, Git repositories, Provider Homes, and provider Sessions | Their external owning systems; Farming is one client |

The Farming package installation is not part of the Config identity. Package
selection and update coordination are defined separately.

## Server Ownership

A Config owner is either:

- **unowned**: no valid owner is published;
- **owned**: one exact live Server owns the Config;
- **uncertain**: ownership metadata exists but cannot be safely verified.

Startup publishes ownership atomically before initializing Config-owned
runtimes. A proven live owner rejects a second startup. A proven dead owner may
be reclaimed. Malformed, unreadable, permission-ambiguous, or otherwise
unprovable ownership fails closed and requires operator action.

Every start surface uses that rejection as a visible failed start. In
particular, `farming daemon` must not return success, reuse the old Server, or
print the old URL as though the requested image had started. The operator must
stop the live same-Config Server before starting another one.

Age is not proof of death. The Server lifecycle is crash-only: persistence,
ownership, and recovery must remain correct after abrupt termination and must
not depend on graceful shutdown hooks. Stop, crash recovery, and cleanup may
signal or release only the exact process and ownership claim they can still
prove.

An intentional Config stop is one exact hard-stop operation even when the
Server is already absent. Config-owned process-group roots publish durable
identity records before accepting work. Stop combines those records with
exact Host endpoints and persisted Runtime and Resource identities, verifies
the current operating-system identity, and sends `SIGKILL` directly. Computer
containers are selected by persisted container id and exact Config ownership
labels and receive Docker's `KILL` signal. Missing or mismatched proof is a
visible failure; stop never scans or signals every process owned by the user.
A zombie process-group leader is already terminated and cannot execute or
receive a useful signal, but that fact alone does not prove its descendants
stopped. Stop inspects the complete group: an exited-only group is reconciled
without a signal, while live descendants still receive the exact group
`SIGKILL`. Because identity and
environment checks are separate operating-system observations, Stop also
rechecks an apparent mismatch once before refusing: disappearance or zombie
state is reconciled as exited, while a still-live mismatch remains a visible
failure and is never signalled.

Stopping one Terminal follows the same hard-stop ownership rule. The native
and local PTY engines signal the complete process group with `SIGKILL`, never
only its leader PID, so background descendants cannot outlive the Agent row.
They revalidate the recorded leader identity immediately before signalling;
an identity mismatch or an existing leader whose identity cannot be read fails
visibly without signalling. The exit path applies the same group cleanup before
releasing the durable ownership record.

## Runtime And Authentication Isolation

Config-owned storage and runtime namespaces must derive from the same canonical
identity. Different Config instances therefore receive independent tokens,
browser cookies, native PTY endpoints, managed runtime bindings, Browser
profiles, Computer ownership, and persisted process records.

A copied Config must not gain authority over processes created by the original
instance. Persisted process cleanup requires both Config ownership and exact
process identity; ambiguous evidence fails visibly.

External Projects and Provider Homes remain shareable. Farming must not prevent
another editor, Git command, Provider tool, or Farming instance from using them.
Conflicts in those resources converge through their own authoritative state.

## Browser Routing Boundary

The live Server owns the browser base path for its instance. The entry document
establishes one immutable routing snapshot before application transports start,
and all same-origin HTTP, WebSocket, navigation, and asset URLs use that
snapshot. Build-time defaults may support isolated development or preview, but
must not override the live Server's routing authority.

A base-path change requires a fresh entry document. Missing or inconsistent
routing must fail visibly instead of silently sending requests to the origin
root.

## Safety And Liveness

Safety requires:

1. one valid live owner per canonical Config identity;
2. no Config-owned runtime initialization before ownership is established;
3. no destructive process action without exact Config and process proof;
4. no collision between different Config-owned mutable namespaces;
5. no invented exclusive ownership of external resources.

Liveness requires a free Config to start, a proven stale owner to be reclaimed,
and every ownership attempt to reach success or a visible bounded failure. When
the operating system cannot prove ownership, Farming intentionally waits for
operator resolution instead of guessing.

## Acceptance Criteria

Verification must cover concurrent same-Config startup, different Configs
running together, symlink equivalence, stale and uncertain ownership, exact
process cleanup with and without a live Server, hard-stop signal semantics,
independent authentication and runtime namespaces, browser base paths, and
safe sharing of Projects and Provider Homes.
