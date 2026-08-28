# Package Installation And Update Lifecycle

> Chinese version: [package-installation-lifecycle.zh_cn.md](./package-installation-lifecycle.zh_cn.md)

This document defines how Farming installs and updates application versions
when several Config instances may share one npm installation.

## Product Outcomes

- A fresh installation starts without downloading fixed runtime dependencies.
- Preparing an update does not stop the current Server.
- Updating one Config does not replace code used by another live Config.
- A failed restart restores the initiating Config from its exact prior version.
- Source, npm, app-bundle, standalone, and remote deployments keep explicit,
  separate lifecycle boundaries.

## Architecture

An npm installation has three roles:

1. the **Bootstrap Launcher**, a stable entry that selects a version for a new
   launch;
2. an immutable **Package Image**, containing one complete Farming version and
   its verified runtime dependencies;
3. an atomically published **Current Selection**, used only by future launches.

Config state and Package Images have different owners. Config state remains
isolated by Config identity. Package Images are shared read-only within one
installation, while every live Config remains bound to the exact Image that
started it.

Fixed provider, Browser, and Project Files search runtimes are prepared in the
Package Image before installation or update. Application startup verifies an
already prepared artifact and fails with an actionable repair instruction when
it is missing or corrupt; startup does not silently download a replacement.

Project Files search uses the Farming-owned, version-pinned native ripgrep
artifact for the target OS and architecture. Linux images use the static musl
build so this runtime does not add a glibc compatibility branch. A system
`rg`, a WebAssembly implementation, or another search command never replaces
the managed artifact at runtime.

Managed ACP dependencies are always prepared from the pinned manifest. A
matching system provider CLI cannot satisfy that managed dependency. The
prepared image also carries the child-process invocation contract required by
the target platform, including a compatibility loader when necessary.

### npm lifecycle-script constraint

An npm installation must not depend on `preinstall`, `install`, `postinstall`,
or any other npm lifecycle script for correctness. Installing Farming must be
an unpack-only operation: the package image already contains the selected,
verified runtime artifacts required for its target platform.

The release pipeline, not the user's npm client, owns runtime preparation and
platform selection. It must publish the required prebuilt artifacts with the
package image (or declaratively selected platform packages). Server startup
only verifies those artifacts and gives an actionable repair error if they are
missing or corrupt; it never compensates by downloading or preparing them.

The npm image declares the exact Codex and Claude native carrier packages as
platform-constrained optional dependencies, so npm selects the matching OS,
architecture, and libc artifact without executing lifecycle code. The release
pipeline embeds the reviewed agent-browser and ripgrep binaries in the Farming
image; target-specific release images retain only their target artifacts. The
launcher marks npm images as download-forbidden and the runtime manager binds
only an exact declared carrier or embedded artifact after verification.

Because an executable cannot run directly from the standalone CLI's virtual
filesystem, that form atomically materializes its embedded, pinned ripgrep into
the owning Config's private versioned runtime directory before Server
initialization. This is local image extraction, not a download or executable
fallback; the same version and executable verification applies afterward.

## Update State Machine

- **Idle**: no update is active.
- **Preparing**: the target package and runtime dependencies are verified while
  the current Server remains live.
- **Ready to restart**: old and target Images are both available.
- **Restarting**: only the initiating Config stops and starts from the target.
- **Succeeded**: the initiating Config runs the target version.
- **Rolling back**: target startup failed and the prior Image is starting.
- **Rolled back / Failed**: recovery succeeded on the prior version, or a
  visible operator action is required.

Preparation and publication are separate transitions. A target prepared from a
stale selection must not overwrite a newer deployment. Detached work may commit
state only while it still owns the same update operation.

For npm updates, metadata from the update registry proves the exact target
version and integrity. Preparation first honors the operator's configured npm
registry. If that command fails, the helper removes only its owned staging
prefix and retries once with the authoritative update registry explicitly set.
This transition depends on command success, registry identity, and operation
ownership; it must never parse npm log wording or error text. The update reaches
`Failed` only after the authoritative attempt also fails.

Update status opened through a read-only share is observation-only: a requested
forced refresh is ignored, persisted operation recovery is projected without
committing it, and immutable installation directories are not prepared. Owner
or startup recovery remains responsible for durable reconciliation.

## Installation Boundaries

- **Source checkout** follows the repository and package-manager workflow of
  that checkout.
- **npm installation** may use in-app update and immutable Package Images.
- **App bundle** receives its prepared dependencies from the release pipeline.
- **Standalone and remote Server** follow their deployment artifact contract.

One installation form must not silently enter another form's update path. The
Server does not use GitHub Releases as an automatic fallback update source.

## Safety And Liveness

Safety requires:

1. published Images are complete and never modified in place;
2. a live Config stays bound to its exact Image;
3. Current Selection changes atomically from the expected prior value;
4. stop and rollback target an exact Server and exact Image;
5. cleanup retains every current, rollback, recent, or proven-live Image;
6. uncertain live-usage evidence stops cleanup;
7. application startup never downloads a fixed runtime dependency.

Under normal filesystem, process-inspection, and package-registry availability,
every update reaches success, rollback, or a visible bounded failure. An
unrelated Config never needs to stop for another Config's update.

## Recovery Semantics

After a launcher or helper crash, the next Server reconciles update state with
the version actually running. A failed target startup restores the initiating
Config from its exact old Image without overwriting a newer independent
selection. Permission or ownership uncertainty leaves the old Server or Image
untouched and reports a retryable failure.

## Acceptance Criteria

Verification must cover installation with npm lifecycle scripts disabled,
first installation without startup downloads, concurrent Configs, update
preparation while serving traffic, a configured registry failure followed by a
clean authoritative-registry retry without inspecting error text, stale
selection races, exact rollback, failed cleanup, external npm replacement, and
each supported installation form's boundary. The focused npm update state-machine
test is a release-preparation gate, not only an ordinary unit test.
