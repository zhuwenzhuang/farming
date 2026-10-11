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
Package Image before installation or update. Application startup checks prepared
artifact identity, path ownership and version/executability, with an actionable repair instruction on failure; startup
does not silently download a replacement or rescan executable contents for hashes.

Source builds prepare host runtimes after frontend output cleanup. Release builds
leave platform runtime preparation to the package-image owner, so each selected
artifact is prepared once after that cleanup.

Project Files search uses the Farming-owned, version-pinned native ripgrep
artifact for the target OS and architecture. Linux images use the static musl
build so this runtime does not add a glibc compatibility branch. A system
`rg`, a WebAssembly implementation, or another search command never replaces
the managed artifact at runtime.

Managed ACP dependencies are always prepared from the pinned manifest. A
matching system provider CLI cannot satisfy that managed dependency. The
prepared image also carries the child-process invocation contract required by
the target platform, including a compatibility loader when necessary.

Runtime installation verifies the staged executable before atomically publishing
its directory. That rename preserves the verified bytes and version-probe result;
installation does not immediately repeat those checks. Later startup and cache
resolution trust the installed image, checking metadata, regular files, path
containment and configured version probes. They do not compare full-file digests
or detect every byte edit that leaves a runtime functional. Build, download,
transfer and installation remain the content-integrity boundaries.

### npm lifecycle-script constraint

An npm installation must not depend on `preinstall`, `install`, `postinstall`,
or any other npm lifecycle script for correctness. Installing Farming must be
an unpack-only operation: the package image already contains the selected,
verified runtime artifacts required for its target platform.

The release pipeline, not the user's npm client, owns runtime preparation and
platform selection. It must publish the required prebuilt artifacts with the
package image (or declaratively selected platform packages). Server startup
checks artifact identity and executability and gives an actionable repair error
when those checks fail; it never compensates by downloading or preparing them.

The npm image declares the exact Codex and Claude native carrier packages as
platform-constrained optional dependencies, so npm selects the matching OS,
architecture, and libc artifact without executing lifecycle code. The release
pipeline publishes reviewed agent-browser, ripgrep, node-pty and legacy Linux libraries in
six OS/CPU carrier images, pinned as npm aliases to platform versions of
`farming-code`. Only Linux x64 carries glibc; Linux carriers retain their GNU
and static Browser variants. The main npm image contains none of these native
payloads. Source, app and standalone images retain their embedded layout.
The launcher marks npm images as download-forbidden. A declared carrier must
match its exact version, platform and image ownership; an absent or invalid
carrier never falls back to an embedded or downloaded runtime.

Packaging validates and packs all carriers before removing their payloads from
main-image staging. Tests install the unpublished main and carrier archives
through an isolated registry with lifecycle scripts disabled. Publication
verifies each carrier's receipt and public integrity before uploading the main
version. Each carrier and the main package have separate upload ownership: an
uncertain carrier upload is reconciled without replay, while recovery can still
publish a main package whose upload step never started. Installer
staging, cancellation, preflight and atomic publication retain their existing
ownership and failure semantics. Updates and rollback select each image's own
immutable carrier.

Because an executable cannot run directly from the standalone CLI's virtual
filesystem, that form atomically materializes its embedded, pinned ripgrep into
the owning Config's private versioned runtime directory before Server
initialization. This is local image extraction, not a download or executable
fallback; the same version and executable verification applies afterward.

Standalone Worker entrypoints are bundled and explicitly included as executable
snapshot scripts. Files directory pagination uses its packaged workspace-tree
Worker; a missing entry fails visibly. Release packaging verifies real directory
capture, bounded continuation pages, stable membership, and Worker cleanup in the
standalone executable, including Linux architecture smokes.

### Source checkout preparation

Source startup prepares the pinned native Browser runtime after the frontend
build, because that build replaces `dist`. A source-and-platform-keyed verified
cache outside `dist` survives ordinary restarts. A missing cache is populated
from explicitly supplied build artifacts or the pinned native build; a failed
build never publishes a reusable cache. The first native build requires the
pinned Rust toolchain and network access. Release packaging still requires its
own exact-Farming-SHA artifacts.

Managed runtime caches are matched per dependency by version, platform, artifact
integrity, entry path, executable digest, and the current probe contract. A change
to the aggregate manifest alone does not invalidate unchanged dependencies. Only
a complete preparation publishes a binding for the current manifest.

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
state or cross a publication, stop, activation, or start boundary only while it
still owns the same update operation. Ownership-sensitive effects revalidate
under the update-state claim and retain that claim through the effect, so a
timeout fence cannot interleave after validation. Ownership commits,
authoritative Server persists, and state removal serialize through an
exclusive update-state lock carrying the holder's exact process identity; a
claim is broken only when that identity is proven dead, and writers that
bypass the lock are outside this guarantee. If a mutation completes but its
claim cannot be proven released, the operation fails visibly and the same
process retains that exact claim for a bounded release retry before its next
mutation. A process restart instead makes the old identity reclaimable through
the ordinary dead-holder path; neither recovery path replays the completed
state mutation.

Crossing a preparation, restart, or rollback deadline is itself an ownership
transition. The Server conditionally replaces the timed-out operation with a
terminal failure only while the exact operation and observed phase still match;
the failure carries a new operation identity. Any late detached helper commit
still carrying the timed-out identity is rejected, and a user retry starts
another new operation instead of sharing ownership with the late helper.

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

The two public setup paths are a standard npm global installation using the
host's supported Node.js and npm, and a user-directory installation with private
runtime carriers. Both consume the same npm release and require an explicit CLI
start. The latter is not a project-local `npm install`; it owns a separate
application directory. Compatibility preparation belongs to that installer and
its published image, not to a normal global npm installation or its hooks.

### User-directory bootstrap

The public installer downloads Farming and its pinned Node.js and npm carriers
from the selected npm registry. A system Node.js, global npm prefix, root
permission, and npm lifecycle scripts are not prerequisites. Linux x64 images
carry the reviewed private glibc runtime for hosts with glibc 2.17–2.27.

The public setup presents separate download, install, change-directory, and start
commands. The download must succeed before the user executes the script. `--dir`
selects an absolute installation directory and overrides `FARMING_INSTALL_ROOT`.
Downloading requires a trusted host CA store; the installer never disables TLS verification or changes system
trust. Before downloading packages, it selects an available SHA-512 verifier
(`sha512sum`, `shasum`, or OpenSSL). The first two use `base64` and `od` to decode
npm integrity metadata. A missing verifier, failed verification command, or digest
mismatch fails explicitly before extraction; verification failure never switches
tools or skips integrity checks.

The installer names each package resolution, download, integrity check, and
extraction phase, and reports dependency installation and runtime preparation.
Archive downloads expose transferred bytes, speed, and an estimated remaining
time when the server provides the total size; an unknown size must not be
presented as a fabricated percentage or overall installation progress.
Only the current successful HTTP response supplies archive progress; redirects
and error responses reset the meter and never count as downloaded archives.
Interactive terminals use the startup progress vocabulary: compact cyan download
bars, yellow preparation/retry messages, and green readiness. Parallel transfers
retain separate rows; redirected output uses bounded plain-text updates, without
cursor controls. Cancellation and failure restore the terminal cursor.
Successful npm and runtime-preparation diagnostics stay private: staging paths
and machine JSON are not installation status. A failed preparation step preserves
a private diagnostic log next to the requested installation directory and prints
its location. Completion names only the published directory and launcher.

After the verified Farming package supplies its runtime pins, Node.js and npm
archives download concurrently under the installer's ownership. Each transfer
has the existing bounded connection, transfer, and retry limits. Both must
succeed before runtime verification and extraction; a failed transfer or user
cancellation stops and reaps the other owned download before staging cleanup.
Progress remains attributable to each package. A later invocation starts a new
installation attempt under the same lock and publication rules.

`--mirror cn` explicitly selects npmmirror for archive and dependency downloads;
official npm metadata remains authoritative for the requested Farming version,
runtime pins, and archive SHA-512 digests. It overrides configured registries for
this installation without changing npm configuration. Mirror archive transport
failures fall back once to the same official artifact, with a visible message;
integrity failures remain terminal. The installer places the verified platform
carrier into its exact alias directory even if npm omits it because mirror
metadata is stale; provider optional dependencies remain enabled. Mirror attempts have bounded connection,
transfer, and low-speed deadlines. An unavailable official metadata read fails
explicitly rather than selecting an older mirror tag. The saved launcher keeps
the official update metadata registry separate from npm's download registry,
so existing update fallback and integrity rules still apply.

The installer owns only its private staging directory and installation lock.
Its transitions are downloading, verifying, preparing, publishing, and installed.
All archives are integrity-checked before extraction, and native runtime
preflight must succeed before an atomic directory rename publishes an install.
Failure before publication removes only staging; failure after publication
leaves the installation available for diagnosis and repair. Concurrent
installers fail explicitly. Repeating the installer checks the selected registry for the target version.
If already selected, it downloads no archives. Otherwise it prepares and verifies
a complete image, then uses the existing package-image owner to publish and
atomically select that image for future launches. The selection compares against
the version observed before downloading, so concurrent updates cannot be
overwritten. Bootstrap files, running processes, Config state and history stay
intact; failure leaves the previous selection available. The installer never
starts or restarts the Server.

The installation retains its selected npm registry for later launches and updates, without rewriting the user's npm configuration.
Its npm cache and default Package Image store live inside the installation
directory, including bootstrap downloads. Selecting a directory on another disk
must not require a separate cache or package-storage environment override.

The stable entry lives directly in the selected installation directory and invokes
an absolute private runtime path. Installation creates no external command link
and does not change PATH. Completion prints full-path foreground start, background
start, and stop commands with their purpose. Output identifies a fresh install,
an unchanged target, or the current-to-target version transition before downloading.
Installation never starts, stops, or restarts a Server;
users start Farming explicitly through the CLI. The user-directory example invokes that
entry by its full path so first use does not depend on PATH configuration.
Configuration, credentials, and session data remain separate from the
program directory. The installer does not change shell startup files or register
an operating-system startup service.

Each managed image owns its pinned Node.js, npm, and compatibility libraries.
Node.js and npm pins are installer metadata, not application dependencies:
ordinary npm installations do not download them. The directory installer downloads the selected platform carrier in parallel
with Node.js and npm, verifies its SHA-512 digest before extraction, and uses
its loader to bootstrap Node.js on old Linux. It seeds npm with the verified
carrier archive, then installs the exact alias with lifecycle scripts disabled.
The directory installer moves
its verified bootstrap runtimes into the staged image after npm finishes.
During managed updates, the existing update operation installs the target's
exact runtime pins into private staging before preflight and publication.
Runtime preparation failure leaves the active image untouched; retry, ownership,
cancellation and cleanup follow the same update operation. No runtime is shared
mutably across images, and rollback still selects the prior image's runtime.
Preparation, target startup, and rollback use the selected image's runtime.
The launch environment must not replace the user's shell PATH or global loader
configuration. Runtime absence is an explicit repair failure, never a fallback
to system Node.js. Ordinary npm and source installations retain their existing
launch contracts.

Frontend-only libraries are development dependencies. Their compiled browser
assets ship in `dist`; their source dependency trees are not bundled again in
the npm image. Libraries served directly by the backend remain runtime
dependencies.

Inline visualizations retain the complete compiled Lucide icon runtime so
generated documents can select icons dynamically. Removing the duplicate npm
source tree must not restrict those icon names. Native PTY debugger symbols
and xterm JavaScript source maps are omitted only from the isolated npm image;
the terminal JavaScript/CSS remains in the main image, while each selected platform's
executable, native addon, shared library and license ships in its carrier. These build-time
size reductions must work with installation scripts disabled.

Runtime assets include only the active product and PWA icons. Design masters,
historical icons and reference artwork remain in the repository but do not ship.
The npm image omits duplicate SheetJS browser builds and ACP SDK test suites,
declarations and debug maps; runtime modules, code-page tables, schemas and
license notices remain available.

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
user-directory installation without system Node.js or a configured executable
PATH, integrity/preflight failures before publication, repeat/concurrent
installation, and per-image Node.js selection during update and rollback,
first installation without startup downloads, concurrent Configs, update
preparation while serving traffic, a configured registry failure followed by a
clean authoritative-registry retry without inspecting error text, stale
selection races, exact rollback, failed cleanup, external npm replacement, and
each supported installation form's boundary. The focused npm update state-machine
test is a release-preparation gate, not only an ordinary unit test. Deterministic
timeout coverage must prove that late detached-helper commits cannot replace the
terminal timeout state.

Release preparation must also run the installer against the actual npm tarball,
covering repeat installation, a real PTY, HTTP startup, and exact cleanup of its
isolated Config.

Installation or update changes also require an isolated cross-version smoke on
legacy Linux: activate an actual npm candidate, verify HTTP and native PTY,
force a target startup failure and verify recovery, and inspect removal of old
Images and runtime dependencies under the default retention policy. Distinguish
unpublished candidates and seeded historical fixtures from published releases
and actual upgrade attempts. Preserve the bootstrap and npm download cache.
