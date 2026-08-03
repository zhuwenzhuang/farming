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

Fixed provider and Browser runtimes are prepared at installation or update
time. Application startup verifies an already prepared artifact and fails with
an actionable repair instruction when it is missing or corrupt; startup does
not silently download a replacement.

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

Verification must cover first installation without startup downloads,
concurrent Configs, update preparation while serving traffic, stale selection
races, exact rollback, failed cleanup, external npm replacement, and each
supported installation form's boundary.
