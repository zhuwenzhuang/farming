# Package Installation And Update Lifecycle

> Chinese version: [package-installation-lifecycle.zh_cn.md](./package-installation-lifecycle.zh_cn.md)

This document defines how Farming installs and updates application versions when
several Config instances may be running from one npm installation. The model is
inspired by VS Code's stable launch surface, version-addressed remote installs,
and explicit updater state machine.

## User Stories

- A first-time npm user starts Farming with the version installed by npm.
- An in-app update is prepared without stopping the current Server.
- Updating Config A does not stop or replace the code used by live Config B.
- New Configs use the selected version, while existing Configs remain on the
  exact version that started them.
- A failed restart restores the initiating Config from its exact prior version.
- An explicit later `npm install` or `npm update` becomes the version selected
  for new launches.
- Source, app-bundle, and standalone installations keep their own deployment
  paths and never silently enter the npm update lifecycle.

## Architecture

An npm installation has three roles:

1. The **Bootstrap Launcher** is the stable command installed by npm. It locates
   the installation and chooses the version for a new launch.
2. A **Package Image** is a complete, immutable Farming version. Running
   processes load code only from their selected Image.
3. The installation-wide **Current Selection** is a small atomically replaced
   pointer used only by new launches.

Config state and Package Images have different ownership. Config state remains
isolated by canonical Config directory. Package Images are shared read-only by
all Configs belonging to one npm installation. A Config records the exact live
Image it uses so cleanup can preserve it.

An explicit npm replacement changes the Bootstrap contents. The Launcher treats
that new Bootstrap generation as an intentional deployment and publishes it as
the selection for future launches. It never mutates Images already used by live
processes.

## Update State Machine

The durable business states are:

- **Idle**: no update is active.
- **Preparing**: the target package and its runtime dependencies are being
  verified while the old Server remains live.
- **Ready to restart**: immutable old and target Images exist and the initiating
  Config may restart.
- **Restarting**: the exact initiating Server is stopped, the selection changes,
  and that Config starts from the target Image.
- **Succeeded**: the initiating Config is running the target version.
- **Rolling back**: target startup failed and the initiating Config is starting
  from its exact prior Image.
- **Rolled back / Failed**: recovery completed on the prior version, or a visible
  operator action is required.

Preparing and selection publication are separate transitions. The selection is
changed with compare-and-swap, so an update prepared against an older selection
cannot overwrite a newer deployment. Only the initiating Config is stopped.

The Config-local update operation record describes at most one still-relevant
operation. It is not authoritative for the installed version or for UI state.
Each record carries a format version and operation id, and every read reconciles
it against the running version, Installation identity, and Package Selection.
Detached helpers may publish a transition only while that same operation id
still owns the record, so a timed-out helper cannot overwrite a later attempt.
An external npm deployment that supersedes the target, an Installation change,
an expired terminal result, or an unrecoverable legacy record converges to Idle.
Terminal errors remain briefly visible while durable diagnostics stay in the
update log. Registry versions older than the running version are not presented
as update targets; rollback uses only verified local immutable Images.

## Safety And Liveness

Safety depends on these invariants:

1. Published Images are complete and are never updated in place.
2. A running Config remains bound to its exact Image for its process lifetime.
3. The Current Selection changes atomically and only from the expected prior
   selection.
4. Stop and rollback target an exact Server process identity and exact Image.
5. Cleanup never removes Current, Previous, recent, or exactly live Images.
6. Unreadable live-usage evidence stops cleanup instead of being interpreted as
   proof that an Image is unused.

Under normal filesystem, process-inspection, and npm availability, every update
transition reaches success, rollback, or a visible bounded failure. An unrelated
Config never has to stop for another Config's update. A stale selection race
causes the initiating Config to restart its old Image and asks the user to retry
against the new selection.

## Recovery Semantics

- A Server starting after a helper or launcher crash reconciles the durable
  restart state with its authoritative running version.
- If the target version is running, restart recovery converges to success.
- If target startup fails, the initiating Config is restarted from its exact old
  Image even when another process has since selected a different version.
- A selection that moved independently is never overwritten during rollback.
- A signal permission error leaves the old Server running and returns the update
  to a retryable ready state.
- Package cleanup is best-effort after healthy startup and fails closed when
  ownership evidence is uncertain.

## Installation Boundaries

Only npm installations use in-app self-update. Source checkouts are launched
directly and follow their Git workflow. App bundles and standalone executables
are replaced through their external installer or deployment process. The Server
does not fetch GitHub Releases as an alternate update source.

## Verification Strategy

Continuous verification should cover bootstrap and Image-local launch behavior,
external npm replacement, atomic selection races, exact live usage retention,
fail-closed cleanup, target startup failure, rollback failure, and two live
Configs where only the initiating Config restarts into the new version.
