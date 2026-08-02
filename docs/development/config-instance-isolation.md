# Config Instance Isolation

> Chinese version: [config-instance-isolation.zh_cn.md](./config-instance-isolation.zh_cn.md)

This document defines how Farming instances share one machine without confusing
their own mutable state or claiming ownership of external developer resources.

## User Stories

- A user can start two Farming Servers with different Config directories and
  use both at the same time.
- Starting a second Server with the same Config directory fails before it can
  initialize Agents or other Config-owned runtimes.
- A Config directory reached through a symlink is the same instance as its real
  path.
- Copying Config state cannot authorize the copy to stop processes owned by the
  original instance.
- Two instances may open the same project or Provider Home as ordinary external
  clients. Farming must not invent machine-wide ownership that excludes editors,
  Git commands, Provider tools, or other software.

## Instance Boundary

The canonical Config directory is the Farming instance identity. Farming
resolves existing symlinks and normalizes not-yet-created descendants against
their nearest existing ancestor. A stable fingerprint of that canonical path is
used only as a compact namespace; the canonical path remains the source of
truth.

Resources fall into four classes:

| Resource class | Isolation mechanism |
| --- | --- |
| Farming-owned persistent state | Stored below the canonical Config directory |
| Farming-owned runtime namespaces | Derived from the canonical Config fingerprint |
| Farming-owned child processes | Exact process identity plus Config fingerprint |
| External projects, Git state, Provider Homes and Sessions | Shared as ordinary external resources; conflicts are handled by their owning system and authoritative rereads |

The Farming package root is not part of this contract. Coordinating updates of a
shared installation is a separate lifecycle problem.

## Server Ownership State Machine

The Config owner has three meaningful states:

- **Unowned**: no published owner claim exists.
- **Owned**: a complete claim identifies one exact live Server process.
- **Uncertain**: a claim exists, but its process identity cannot be safely
  verified.

Startup first prepares a complete claim containing the canonical Config identity
and an exact operating-system process identity, then publishes it atomically.
Publication never intentionally replaces an existing claim.

When a claim already exists:

- an exact live owner rejects the new startup;
- an exact dead owner or proven PID reuse may be fenced and reclaimed;
- an unreadable, malformed, incomplete, or permission-ambiguous owner fails
  closed and requires operator investigation.

There is no heartbeat or time-to-live. Age is not proof that an owner is dead.
Normal stop releases only the claim that still matches the exact Server being
stopped, fencing that claim before the shared owner path becomes available.
After a crash, the next startup performs the same proof before recovery.

## Runtime And Authentication Isolation

Config-owned registries, Browser profiles, Computer ownership labels and names,
native PTY socket identity, runtime dependency state, tokens, and browser cookies
all derive from the same Config boundary. A different Config therefore receives
different mutable storage and runtime namespaces even when both Servers run as
the same operating-system user.

Browser cookies include the Config fingerprint because cookies are not isolated
by TCP port. Machine clients use bearer authentication and do not depend on a
shared browser cookie name. The former cookie remains a read-only compatibility
path during migration.

Persisted ACP process records carry both exact process identity and Config
identity. Cleanup verifies Config scope before signalling a live process. Legacy
records without Config identity may use exact live process-environment evidence;
if that evidence is unavailable or ambiguous, cleanup fails visibly.

## Runtime Base Path Contract

The live Server is authoritative for the browser base path. It injects
`window.__FARMING_BASE_PATH__` into the entry document before application
modules load. The React application resolves same-origin HTTP, WebSocket,
navigation, and asset paths only through `appPath` and `appWsUrl` in
`src/lib/base-path.ts`. Feature code must not read Vite `BASE_URL`, consume the
injected global, or implement another base-path helper.

The minimal state model is:

- **Owner:** the Server process and its configured `FARMING_BASE_PATH`;
- **initialization trigger:** parsing the Server-generated entry document;
- **guard:** normalize the injected path before any browser transport starts;
- **effect:** every same-origin route is joined to that one normalized path;
- **fallback:** Vite's build-time base is used only when no runtime path exists,
  such as an isolated development or static-preview build;
- **failure:** a missing or bypassed resolver must fail a continuous test rather
  than silently target the origin root;
- **recovery:** a base-path change requires a fresh entry-document load, which
  establishes a new immutable browser routing snapshot.

Build and startup scripts also pass the same default base path as a
defense-in-depth check, but runtime correctness must not depend on build-time and
Server paths matching. Tests must cover an artifact built for `/` while the live
Server path is `/farming`, because installed, Desktop, preview, and remote
surfaces intentionally use different build profiles.

## Correctness Argument

Safety depends on these invariants:

1. At most one valid owner claim is published for one canonical Config path.
2. A Server initializes Config-owned runtime state only after it owns that claim.
3. Config-owned mutable resources are addressed by canonical Config path or its
   fingerprint, so different Config identities do not collide.
4. A persisted process may be signalled only after both exact process identity
   and Config ownership are proven.
5. External resources are never treated as exclusively owned merely because one
   Farming instance opened them.

Under normal filesystem and process-inspection availability, liveness follows:
a free Config can start, a proven stale owner can be reclaimed, and every failed
claim reaches a bounded success or visible failure. If the operating system
cannot prove ownership, the system deliberately favors safety and waits for
operator resolution rather than guessing.

## Recovery And Failure Semantics

- A duplicate startup reports which live Server owns the Config.
- A stale exact owner is reclaimed without requiring a timeout.
- Unknown ownership is never automatically deleted.
- A copied Config cannot use persisted ACP metadata to stop the original
  instance's live process.
- External project or Provider conflicts remain visible through the underlying
  filesystem, Git, or Provider behavior and converge through authoritative
  rereads; Farming does not promise cross-process transactions for them.

## Verification Strategy

Continuous tests should cover concurrent same-Config startup, stale and uncertain
owners, symlink equivalence, two live Servers with different Config directories,
disjoint Config-owned paths and runtime namespaces, scoped cookies and bearer
clients, native PTY identity, Browser and Computer ownership, and ACP cleanup
fencing. At least one integration test should run two real Servers concurrently
and verify their independent settings, tokens, cookies, and runtime identities.
