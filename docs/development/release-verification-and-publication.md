# Release Verification And Publication

> Chinese version: [release-verification-and-publication.zh_cn.md](./release-verification-and-publication.zh_cn.md)

This document owns release preparation, exact-candidate verification, publication,
and failure recovery. The release clock starts when the request is accepted and
includes investigation, fixes, queueing and publication.

## Objectives

- Normal end-to-end release target: 15 minutes, with 10 minutes as the stretch
  target. External queueing and npm public-availability waits still count.
- A simple failure: classified, reproduced, and minimally fixed within 3 minutes
  after actionable failure evidence is available.
- A complex failure: classified and escalated to an explicit root-cause
  investigation within 3 minutes; no unbounded guessing loop.
- Ordinary CI wall time must not become slower.
- Ordinary CI must not add LLM or Agent polling work.
- Existing platform, package, runtime, provenance, and exact-SHA requirements
  remain mandatory.
- npm is the final public mutation. It must not be published until the matching
  GitHub Release and required assets are publicly usable.
- The npm tarball published must be byte-for-byte identical to the tarball that
  passed package smoke tests.

If any release exceeds its target, the complete elapsed time still counts. The
result is a missed objective with an exact attribution to investigation, CI,
artifact preparation, publication, queueing, or an external provider. It is not
reclassified as development time.

## Three Operating Scenarios

### Scenario 1: No blocker

The exact candidate has no newly discovered defect. Full CI, release artifact
preparation, and npm package smoke run in parallel. GitHub Release is published
and verified before npm. Aim to finish the complete path within 15 minutes.

### Scenario 2: A simple blocker

A changed-area fast screen runs beside the full pipeline and is designed to
surface common metadata, test-oracle, packaging-manifest, and focused product
failures within 2 minutes. The Agent has 3 minutes to classify, reproduce, and
minimally fix the defect. The corrected candidate then has a 10-minute complete
pipeline budget. The total objective is therefore 15 minutes, with no timer
reset.

If a simple failure is first discovered late, the release misses this objective.
Its stable failure signature and focused reproduction must be added to the fast
screen so the same class of defect is early on later releases.

### Scenario 3: A domain has a substantial design problem

This is an expected and common case. The affected domain enters `blocked-design`
instead of stopping the whole release campaign. Every independent domain keeps
building, testing, fixing, and converging:

- ordinary repository checks;
- browser and interaction behavior;
- Linux and macOS packaging;
- npm package construction and runtime smoke;
- release metadata, manifests, and publication reconciliation.

The campaign records the complete design-resolution time. In parallel it keeps
a domain ledger with `unknown`, `running`, `green`, `blocked`, and `stale`
states, the tested SHA, failure signature, and responsible evidence.

When the blocked domain is resolved, all affected domains become stale and the
final exact SHA runs the complete parallel pipeline. Earlier domain results are
used to remove unknowns and warm deterministic caches, but never replace final
exact-SHA evidence. From design resolution to npm verification, the remaining
release targets 15 minutes, while the full design-resolution time still counts.

## Mandatory Release Preparation Gate

Testing is part of the measured release campaign. It is not an optional activity
that happens before the release clock starts. No tag, public GitHub Release, or
npm version may be created until the required preparation evidence converges.

After version, SHA, changed behavior, and selected scenarios are fixed, all
reversible work starts together:

```text
exact-SHA CI       platform artifacts       one npm tarball
automated UX       live-provider gates      Computer Use lanes
        \                 |                 /
         +------ preparation ledger -------+
                         |
               public GitHub Release
                         |
                 public verification
                         |
                  npm publication
```

Before freezing the first candidate, retain the integrated base SHA from the
initial snapshot and run `npm run release:fast-screen` plus
`npm run release:browser:screen -- --base BASE_SHA`. The browser screen selects
owning changed-area checks, builds shared outputs once, and runs bounded isolated
lanes. Inspect `--plan` before execution; unmapped product changes require an
owning check rather than silently receiving no coverage. Repair failures locally
and repeat only affected checks before freezing the candidate. These early checks
do not replace final exact-SHA CI or artifact acceptance.

The middle fan-out has a seven-minute wall-time target. GitHub publication and
public verification precede npm; runtime versions can publish in parallel, but
the main package waits for every runtime's public source and digest verification.
External public-availability waits may exceed the remaining budget. Record this
as a missed objective instead of shortening observation or declaring success.

Before the fan-out starts, release preflight queries the public npm registry for
the `latest` versions of the pinned Codex and Claude ACP adapters, ACP SDK, and
managed Codex runtime. Claude ACP updates are coupled to Codex maintenance: a
new Claude ACP version is informational and does not block a release while both
managed Codex pins remain current; when either managed Codex pin needs an update,
Claude ACP must also be reviewed and updated to `latest` in the same maintenance
change. A managed Codex runtime update is actionable only after every declared
platform package for that version is present in the public registry; an
incomplete platform publication is reported and remains on the last complete
version, so it does not trigger a Claude-only update. The preflight also checks
the standalone Claude Agent SDK latest, while
requiring the managed Claude runtime to match the exact SDK version owned by the
current Claude ACP adapter. The standalone SDK result is informational until
that adapter adopts it. A registry failure or any pin required by this policy
that differs from `latest` fails closed before artifact construction. A
maintainer must review the upstream change, update every affected pin, reviewed
patch and integrity hash, and rerun the required acceptance evidence; discovering
a version does not by itself prove that the upgrade is compatible.

At campaign start, run `npm run release:dependencies:plan -- PLAN_PATH` once.
The immutable JSON plan groups exact direct pins, all Codex platform aliases,
and the selected Claude adapter's SDK platform pins, while retaining deferred
and incomplete publications. Apply its manifest edits together and resolve the
lock once. The plan also discovers remaining source and test version references
without editing them or treating generated runtime outputs as authoritative.
Review changed vendor patches and hashes, then run the focused fast
screen before pushing the final candidate. The generated runtime manifest reads
its Codex pin from the root override and its Claude SDK pin from the adapter's
locked dependency; it does not maintain another manually updated version pair.
Discovery and plan generation do not approve upstream compatibility or replace
the final exact-SHA gates.

Run `npm run release:upgrade:screen` immediately after the single clean install.
It prepares the reviewed adapters and runtime manifest, then exercises the
provider-neutral ACP boundary and owning adapter compatibility checks, including
cold patch installation and packaged vendor selection and integrity. CI runs
this screen before the broad repository checks
so an upgrade defect is actionable early. Its isolated deterministic fixtures
do not require provider credentials or registry mutations; a preparation or
compatibility failure stops the screen. It does not replace full CI, installed
package acceptance, or the real-provider gate.

### Candidate-triggered workflow coverage

The release coordinator monitors every workflow created by the exact candidate
push, not only `CI` and `Release`. `scripts/watch-candidate-workflows.sh SHA`
discovers the push runs, records their state, and produces a bounded failure
bundle for any non-successful result.

A triggered workflow is required by default because its path filter proves that
the pushed candidate changed its domain. In particular, when `Documentation`
runs for the candidate, the GitHub Pages deployment must succeed before release
acceptance can become successful and before npm publication. A workflow from a
different SHA is reported as repository health context but does not block the
candidate.

GitHub Pages normally advances from `deployment_queued` within seconds. The
Documentation workflow limits this state to three minutes and uses the current
Node 24 `deploy-pages` action. A timeout is classified as an external provider
failure and counts in total release time. It does not authorize repeated full
documentation builds or a longer hidden wait; independent preparation lanes
continue while the documentation domain remains blocked.

### Automated interaction and Computer Use are separate

Playwright human-story tests and real-provider browser composites are automated
interaction gates. Computer Use means an Agent operating a real Desktop through
Computer tools. Their evidence and scheduling must not be conflated.

Automated gates include:

- a live real-Codex baseline of at most 90 seconds for a normal product release;
- focused owning Playwright or product smoke for every changed behavior;
- the real-provider Code/CRT/Terminal composite only for shared lifecycle,
  protocol, provider, session-identity, or cross-runtime changes.

Computer Use uses a remote Linux pool of isolated Docker Desktops. The release
coordinator creates one Agent and one owned Computer Resource per independent
scenario. Each lane has an isolated Desktop, profile, workspace/fixture, and
evidence directory. Actions within one lane are sequential; independent lanes
run concurrently.

Build a complete source environment with `npm run build`, or use a verified
app bundle. Before launching an operator, run
`node scripts/check-release-computer-environment.mjs ROOT FULL_SHA PINNED_IMAGE`
in the Linux lane environment. Its read-only receipt binds the candidate,
generated runtime inputs, managed ripgrep, child Node/native PTY loading, and
already-present Docker image. A working parent Node does not prove child launch
under a private loader. This receipt does not prove Resource/profile readiness:
verify the owned Resource, foreground browser and initial screenshot through the
real Computer path before starting the bounded story. Retain progress receipts
at each completed transition and reserve time for the final report; a watchdog
result remains incomplete even if independent evidence later accepts the story.

At campaign start the coordinator creates a unique commit-status context for the
candidate and marks automated/Computer Use acceptance pending. `release.yml`
prepares and retains the exact candidate artifacts without any public mutation.
After every required interaction lane is green, the coordinator marks the
context successful and dispatches `publish-release.yml` with the exact candidate
SHA, successful preparation run ID, and acceptance context. Publication verifies
all three identities once, downloads only that run's artifacts, and fails closed
instead of waiting on a hosted runner or rebuilding artifacts.

Computer Use selection has three levels:

| Level | Use |
| --- | --- |
| sanity | one normal visible action on the exact candidate; required for product-behavior releases unless a stronger lane subsumes it |
| focused domain | the shortest owner-to-terminal-state user journey for each changed behavior |
| continuity composite | one Session crosses every affected surface and state transition when shared lifecycle or interacting domains changed |

Sharing/access, Chat/ACP, Terminal, CRT, Browser/Computer, and responsive
appearance can use separate parallel lanes. Native macOS Desktop/LSP behavior
requires a Mac lane and cannot be replaced by a Linux container.

### Linux release coordinator exception

When the release coordinator itself runs on Linux, iOS Simulator and physical-
device acceptance are omitted from the blocking release ledger and recorded as
`ios_acceptance=skipped-linux-coordinator-rule`. This is an explicit platform
policy, not an inference that Linux emulation proves iOS behavior. Mobile
Chromium/WebKit automation, responsive-appearance Computer Use, exact-SHA CI,
provider gates, candidate workflows, every platform artifact, and publication
verification remain required. Native macOS Desktop/LSP changes still require a
Mac lane.

Run `npm run release:coordinator:linux:check -- VERSION` after the clean
candidate is pushed to `main` and before release acceptance becomes pending.
The check proves that the Linux coordinator has authenticated GitHub and Codex
CLIs, a healthy Docker daemon, active release workflows, and the exact pinned
Computer image. Release artifacts and npm publication remain owned by GitHub
Actions, so the coordinator does not need npm credentials, Xcode, a modern host
glibc, or local cross-platform packaging tools. The coordinator dependency
probe follows its configured HTTPS npm registry so restricted Linux networks
may use a trusted mirror; the GitHub Release Preparation job still queries the
public npm registry and remains the authoritative dependency gate.

Every lane records candidate SHA, scenario, Agent and Computer Resource
identities, container/image identity, timestamps, screenshots, Computer action
trace, backend/provider evidence, result, and failure signature. Successful
resources are removed by exact identity. A failed Desktop is retained only for
its bounded investigation.

### Failure convergence and invalidation

One failed lane does not restart the fan-out. Independent CI, packaging,
automation, and Computer Use lanes continue. The first evidence is retained and
the failure is reduced to one user action, state owner, violated invariant, and
introducing change before a fix is attempted.

After a fix, final exact-SHA CI, artifacts, npm tarball smoke, and live-provider
baseline rerun because their identity changed. Only Computer Use lanes whose
journey, inputs, or shared contracts changed become stale. An unaffected lane
may be carried forward only with explicit diff-based invalidation proof and its
original SHA; it is never represented as exact-SHA artifact evidence.

## Release Flow

```text
Release request for exact SHA and version
                 |
                 v
        Fast metadata validation
                 |
       +---------+-------------------+
       |         |                   |
       v         v                   v
   Full CI   Platform build      Build one npm tgz
             verify + smoke      smoke exact tgz
       |         |                   |
       +---------+-------------------+
                 |
                 v
       Assemble draft release assets
                 |
                 v
       Publish GitHub Release publicly
                 |
                 v
     Verify tag, assets, download, checksums
                 |
                 v
       Publish the same npm tgz last
                 |
                 v
      Verify npm version and exact gitHead
```

Artifact preparation before the public boundary is reversible. It may run
before CI succeeds, but no public mutation may run until full CI and every
artifact-specific smoke test succeed for the exact same SHA.

For Scenario 2 and Scenario 3, a domain coordinator runs beside this flow:

```text
changed files + failure signatures
              |
              v
      affected-domain selection
       |       |       |       |
       v       v       v       v
      core   browser  package  publication
       |       |       |       |
       +-------+-------+-------+
              |
              v
  domain ledger + final exact-SHA invalidation
```

The coordinator allows independent domains to converge while one domain is
blocked. Any cross-cutting change invalidates every domain whose inputs or
acceptance contract may have changed.

## Artifact And Publication Contract

### Metadata And CI Gates

- A fast metadata job validates version, lockfile, release notes, branch, tag,
  and npm-version conflicts.
- The exact-SHA CI gate continues to wait for the required CI run.
- Platform builds and npm preparation depend only on metadata validation, so
  they run in parallel with the CI gate.
- Public GitHub and npm jobs depend on both the CI gate and all preparations.

### Repository Verification

- Linux artifact construction and npm publication do not repeat `npm run check`.
- Keep exact-SHA CI as the authoritative repository gate.
- Keep every platform-, package-, architecture-, and runtime-specific verify
  and smoke step.

### Parallel Packages And Provenance

- Run Linux CLI, standard app-bundle, and legacy app-bundle as three parallel
  jobs after one metadata gate.
- Run native CLI and app-bundle as two parallel jobs for each macOS architecture.
- Start macOS app jobs after preflight; they do not wait for the independent
  Linux/Windows Browser matrix. The separate CLI, Linux, and npm jobs wait for
  both that matrix and the native app jobs because each complete image needs
  every supported runtime. Reuse unchanged Browser components only from a
  successful in-repository preparation whose commit is an ancestor of the
  candidate and whose pin, patch and production recipe are byte-identical.
  Every platform artifact must still be retained; an expired or incomplete
  origin requires fresh compilation. A rejected artifact fails closed.
  Candidate assembly records the current Farming SHA and digest separately
  from immutable compilation provenance. Each macOS app signs and exercises
  its native Browser on its own packaging runner, including complete App
  verification and smoke. Unchanged component source-regression evidence is
  bound to the authenticated origin; candidate product/package acceptance is
  always fresh. Browser-facing CI uses the same authenticated component
  selection and current-SHA assembly before running its full interaction gates.
  Changed source or recipe uses the original test/build path.
  Cache Cargo intermediates by host OS,
  architecture, target, pinned toolchain, upstream source, patch, and build
  script; source compilation always tests, builds and emits a fresh identity
  after intermediate-cache restore.
  After a source or patch upgrade, restore only within the same host OS,
  architecture, target and pinned toolchain; Cargo fingerprints decide which
  intermediates remain valid. Regression tests retain the host test profile;
  production artifacts retain the release profile and target. Release-profile
  tests would link a separate full-LTO test executable and do not eliminate
  artifact linking. Linux artifacts retain their separate Zig compatibility
  build, whose compiler/linker inputs cannot share the host test graph.
  Independent native Browser producers sign, strictly verify and launch each
  Darwin component before transferring its current-SHA artifact. App consumers
  repeat native signature and version verification on their matching host, then
  run complete Browser, App and PTY acceptance. CLI, Linux and npm packagers
  consume the component without waiting for App acceptance; publication still
  requires all package gates. Transfer preserves immutable compilation
  provenance and never adds a second Rust compilation.
- Retain pinned ripgrep download archives outside the clean source installation.
  Isolate workflow caches by producer, runner OS/architecture and the reviewed
  artifact inventory. Every restored archive must pass its pinned SHA-256 before
  extraction; a missing archive uses the bounded official download path.
- Retain the exact app assembly directory until smoke completes. Verify the
  archive and smoke the retained directory instead of extracting the large
  archive immediately after creating it.
- Keep all jobs reversible until exact-SHA CI and every package-specific gate
  are green.

### Source And Product Installation

- Source CI and release build checkouts set
  `FARMING_SKIP_INSTALL_RUNTIME_PREPARE=1`; they build and test source directly
  and must not create a package-installation runtime seed.
- npm package smoke and app-bundle construction retain their installation-form
  runtime requirements. This optimization does not weaken the published
  installation contract.
- Browser downloads remain explicit workflow steps, so dependency installation
  does not silently download a second browser copy.

### One Verified npm Tarball

- npm package smoke accepts or exports an explicit tarball path.
- Compute the tarball SHA-256 before smoke and after workflow-artifact transfer.
- After smoke, retain a small exact-SHA receipt with byte length, SHA-256,
  SHA-512 integrity, and SHA-1 shasum, both beside the tarball and as a separate
  artifact. Coordination reads the receipt without downloading the tarball.
- Publish that exact tarball directly. Publication must not run `prepack`,
  `npm pack`, or another production dependency installation.

At each artifact boundary, compute all receipt digests in one file pass. The
smoke receipt is the npm transfer-integrity authority; do not add a second
SHA-256 sidecar or hash the same unchanged tarball again in that stage.

### Publish npm Last

- Assemble a draft GitHub Release from verified assets.
- Publish the GitHub Release.
- Verify the public tag target, asset inventory, manifest, checksums, and at
  least one public asset download.
- Only after that verification, publish npm and reconcile its `gitHead`.
- Publication verifies transferred bytes against the smoke receipt and then
  automatically reconciles public name, version, source SHA, integrity, and
  shasum for at most ten minutes with ten-second request bounds. Timestamped
  observation checkpoints and upload outcome are retained on success or failure.
  Recovery after an attempted upload is read-only, including during public 404
  responses; recovery before the upload step may perform the first upload.
- Registry preflight reads use an independent, unpooled HTTPS socket and drain
  their response body before starting upload or observation children.
  A `Connection: close` header on a pooled client is not sufficient;
  no connection may be reused between platform publication steps.
- Validate the complete runtime inventory, transferred tarballs and recovery
  journals before any npm mutation. Up to six independent platform versions
  upload and reconcile concurrently. Each lane exclusively owns its intent,
  result and observation files; persist intent before uploading and never replay
  an uncertain upload. Wait for every lane to settle, retaining all evidence even
  when another lane fails. Only six successful public source/digest checks admit
  the main package upload. Existing public versions may be observed without an
  upload intent; their observation does not authorize a later upload on recovery.
- An accepted upload and public verification are separate states. A successful
  upload followed by public absence or incomplete metadata is `awaiting-public`:
  show "Uploaded successfully; waiting for public availability" in the workflow
  summary and retain a pending `farming/npm-publication/<version>` commit status.
  The bounded observation job may complete while that publication status remains
  pending; workflow success alone is not proof of a public npm release. A
  trusted `workflow_run` continuation performs one further read-only observation
  for at most twenty minutes, authenticated to the original upload run, attempt,
  candidate publication, SHA and canonical smoke receipt. If recovery performs
  the first upload, its uploader identity remains separate from the exact-SHA
  candidate publication and successful preparation proof. It shares per-version concurrency
  with publication and needs no npm credential. A recovery verifier may use
  newer integration code while preserving the original upload identity. An earlier
  recovery may supply the latest journals when that run identifies the exact
  candidate SHA and proves successful recovery gates. If its verifier SHA is
  newer, `candidate_publication_run_id` must separately identify an exact-candidate
  publication with successful preparation, acceptance, push-workflow, draft-publication,
  and public-asset gates; `failed_publication_run_id` still selects the latest journals.
  Those journals must prove recovery checkout, preparation, acceptance, and public
  verification, and every retained runtime intent must match the exact preparation
  receipt before any upload. The main upload origin retains the candidate anchor.
  Without the anchor input, the existing exact-SHA rule remains. Skipped
  original-publication steps alone are not evidence. Every new recovery rechecks
  the candidate's push workflows and preserves the latest journals; the read-only
  observer authenticates this same lineage before continuing a later main upload.
  When observation ends during normal public absence, record `observationStatus=ended`
  and retain pending publication status with read-only recovery instructions.
  Historical evidence without an authenticated upload-origin checkpoint uses
  explicit recovery instead of automatic continuation. Only matching public source
  and digests make the publication status successful. A conflicting public
  identity fails; an ambiguous upload or failed observation remains uncertain.
  Never classify normal public-availability waiting as an upload failure.
- A successful upload may not be immediately visible in the public registry.
  npm performs publish-time scanning, typically taking about five minutes and
  sometimes fifteen minutes or more; these times are not a service guarantee.
  See [npm publish-time scanning](https://github.blog/changelog/2026-07-28-npm-publish-time-malware-scanning-and-dual-use-metadata/).
  A `staged` response or conflict alone does not prove that maintainer approval
  is required: npm staging includes automated validation as well as maintainer
  review. Preserve the exact tarball and reconcile the public version, source
  SHA, and digest with bounded reads before considering another publish.
- Ask for maintainer approval or 2FA only when authoritative evidence establishes
  that requirement. If authenticated staging details are unavailable, report
  the outcome as uncertain rather than declaring manual approval mandatory.
  See the [npm staging API](https://api-docs.npmjs.com/#tag/Stage).

## Test And Failure Feedback

### Browser Build Dependency

- Frontend artifact production is separate from the repository `Check` job.
- Run frontend production, `Check`, and Node compatibility in parallel.
- Browser and mobile jobs depend only on the frontend artifact job.
- `Check` does not repeat frontend artifact production.

### Balanced Browser Shards

- Use nine Chromium shards to match the measured 20-job remote concurrency
  ceiling when release preparation is also active.
- Discover exact test locations once per job and assign atomic location groups
  by measured duration, using a bounded default when a location has no timing
  sample. Rebalance slow locations across the existing Jobs instead of adding
  workers or more remote Jobs.
- Keep exactly one worker per job. Generated tests sharing one source location
  remain atomic, and no backend receives concurrent tests.
- Mobile CI uses five isolated single-worker jobs: two balanced iPhone layout
  shards, separate complete iPhone and Android human-journey suites, and an
  authenticated-share suite with its own auth-enabled server. Preserve every
  original project and location. The changed-area screen runs before candidate
  freeze, not again ahead of the complete iPhone suite. Mobile jobs use the
  digest-pinned official Playwright Noble image matching the lockfile, with Node
  22 selected separately. Verify image/driver/lock versions and actually launch
  Chromium and WebKit before testing; a mismatch fails without installing a
  different browser. Local Linux visual checks use the same image and font recipe.
  Account for queueing against the shared concurrency
  ceiling when measuring the complete release; do not assume linear speedup.

### Failure Bundles

The run watcher atomically checkpoints each successful observation with a
timestamp and active job/step, emitting progress only when it changes. A failed
transport observation rechecks the same run; it never authorizes a new run.

For the first required job failure, generate one machine-readable and
human-readable bundle containing:

- candidate SHA and changed files;
- failed workflow, job, step, test, and first error;
- exact focused reproduction command;
- trace, screenshot, and relevant server/browser logs;
- a stable failure signature used to detect recurrence.

The release watcher defaults to `fail-fast`: it returns the first required-job
failure bundle and records its stopped state and exit code separately from the
authoritative run status, which may still be `in_progress`. Consumers must not
wait on that preserved snapshot as though the watcher were still running.
`wait-terminal` retains the first failure once and continues observing the same
run until its actual terminal result. Error extraction excludes echoed script
source and prefers the real runtime diagnostic. Each GitHub read remains bounded
at thirty seconds and cancellation cleans up its exact owned process group.
Deterministic timeout tests synchronize fixture readiness independently of the
production deadline. Repeated Agent polling is unnecessary.

### Isolated Local Lanes

`npm run test:e2e:playwright:isolated -- --project <name> --lanes <count>`
starts the existing balanced location assignments as isolated lanes. The
coordinator builds once unless `--skip-build` is explicit, then forces every
lane server to reuse that build. It does not forward arbitrary Playwright
arguments, because doing so could bypass the isolation contract.

Lane execution copies are prepared entirely with Node filesystem APIs, without
requiring `rsync` or another host copy utility. The coordinator reads the exact
NUL-delimited `git ls-files -co --exclude-standard` manifest, byte-copies its
regular files, recreates its symbolic links, preserves executable permissions,
and never hard-links tracked or non-ignored WIP back to the source checkout.
Copy destinations are constrained to the lane repository root and unsupported
manifest entry types fail closed.

The Git manifest intentionally excludes ignored build output. After copying
the manifest, lane preparation inherits generated runtime artifacts only from
the canonical backend build output roots: each runtime `.cts` source requires
its adjacent `.cjs` and `.cjs.map`, and explicitly owned singleton runtime
outputs are copied separately. These files are isolated copies rather than
links to the source `backend/`, `desktop/`, `extensions/`, or `shared/` trees,
so plain Node subprocesses can start the native PTY host and ACP runtime host
from the lane clone. A missing required artifact fails preparation with the
build command needed to restore it; there is no fallback to `tsx` module
resolution. The already-built `node_modules` and `dist` roots remain shared
read-only inputs for all lanes.

Each lane owns a unique backend port, config root, temporary directory,
Playwright output and HTML report directory, visual/audit directory, and any
single-file screenshot path. Linux headed execution additionally owns one
unique Xvfb display and sets Playwright `headless: false`. Default ports and
displays are checked before work starts and fail closed when already occupied;
Xvfb must create its display socket before Playwright starts and an early Xvfb
exit fails that lane.

The default Playwright server removes only the config root it created. When a
lane supplies a config root, that lane owns its cleanup and evidence retention.
Teardown must not scan or delete other runs' temporary configuration directories.

Agent cleanup must observe an empty authoritative inventory before the next test
starts. Accepted deletion or archival is polled to completion without replaying
the mutation. Failed reads, rejected or uncertain mutations, malformed inventory,
and deadline exhaustion fail setup; teardown reports cleanup failures alongside
the original test error.

Every spawned command is an owned process group. Interrupt and final cleanup
signal only those groups, escalate from TERM to KILL when required, and return
nonzero after an interrupt. A lane failure does not cancel independent lanes:
all terminal results are collected. Successful runs delete their temporary
lane root by default; failed runs retain trace, report, screenshot, and audit
evidence and print the exact retained paths. `--retain-evidence` also retains
and prints the exact root after success. `--dry-run` creates no server,
directory, or temporary root, while `--list` uses the balanced runner's
supported `--list-selected` discovery mode.

Run `npm run test:e2e:playwright:isolated:matrix` to execute the configured project matrix. By default, the checked-in
coordinator builds once, expands the six project definitions into 12
independently isolated lane invocations, and admits at most six Chromium lanes
at once across all Chromium projects. This is one global limit rather than
three independent project limits; all WebKit lanes remain eligible to run in
parallel. `--max-chromium-lanes <1-8>` is an explicit operator override for a
measured host, while the default remains the validated safe capacity. The
coordinator aggregates every terminal status without automatic retry and
signals only process groups it owns during interruption. Standalone
per-project commands preserve their requested lane count and are not a
substitute for the matrix's global scheduler. A caller may run
`npm run test:e2e:playwright:isolated:matrix -- --skip-build` only when all
build outputs required by the matrix have already been completed and verified
for the exact checkout; the caller owns that verification, and the coordinator
does not prove that existing outputs are fresh. Lane preparation still fails
closed when an expected generated runtime artifact is absent. Its `--dry-run`
mode prints the exact lane commands and, unless `--skip-build` is present, the
build command without side effects.

## Diagnosis Protocol

### Three-minute first response

| Elapsed time after failure evidence | Required result |
| --- | --- |
| 0–30 sec | Read the failure bundle and identify the owning boundary |
| 30–90 sec | Run one smallest focused reproduction or inspect its trace |
| 90–180 sec | State the invariant, classify the failure, and make the minimal fix for a simple defect |

Failure classes are: product logic, test oracle/lifecycle, packaging manifest,
workflow dependency, environment/provider, and recurring known signature.

The Agent must also select the operating scenario and affected domains. It may
move from Scenario 2 to Scenario 3 within 3 minutes when the failure requires a
state-machine, ownership, or architecture change instead of a bounded fix.

### Bounded investigation rules

1. Start from the exact error and owning boundary; do not begin with a broad
   repository search.
2. Run one focused test once. Use up to three repetitions only when the stated
   hypothesis is timing or nondeterminism.
3. Change one hypothesis at a time and record the expected observation.
4. If two fixes under one hypothesis fail, stop editing. Add one-time state
   instrumentation and reconstruct the actual event order.
5. Do not run typecheck, lint, build, or full CI independently after every small
   edit. Run the owning focused check, then one final complete gate.
6. Do not push merely to obtain another diagnostic fact that can be observed
   locally or from the existing trace.
7. Monitoring is owned by a script. The Agent is invoked only for a state
   change, failure bundle, or final result.

### Required state trace for lifecycle failures

Stateful UI and runtime failures must log the authoritative transition rather
than rely on repeated screenshots or final pixels. For persisted Chat position,
for example:

```text
anchor saved
  -> unload/pagehide boundary
  -> initial turns loaded
  -> older turns loaded
  -> anchor element attached
  -> restoration transaction applied
  -> browser/layout adjustment completed
  -> final semantic position observed
```

## Target Timing Budget

| Critical-path work | Budget |
| --- | ---: |
| Candidate discovery, changed-area screen and scheduling | 1 min |
| Full CI and all reversible artifact preparation, in parallel | 7 min |
| Publish GitHub Release and verify public assets | 1 min |
| Parallel runtime publication, main upload and public verification | 5 min |
| Variance reserve | 1 min |
| Total target | 15 min |

These are working budgets for a ready candidate and warm infrastructure, not
measured guarantees. Keep 10 minutes as a stretch target. A product design defect,
cold image, runner queue or npm metadata delay can exceed the budget; count it
and report it. Compare actual per-lane critical paths, not sums of overlapping
domains. Parallel-publication estimates use the slowest lane, not the average.
Only a complete measured release can establish that the end-to-end target was met.

When a failure occurs, the clock continues. The three-minute diagnosis protocol
reduces avoidable investigation time; it does not reset the release timer.

## Acceptance Criteria

- Measurement starts at the accepted release request and includes every retry,
  investigation, fix, queue, CI run, build, and publication step.
- Normal end-to-end release targets 15 minutes, with 10 minutes as a stretch target.
- A release with one simple blocker completes in less than 15 minutes.
- For a substantial design blocker, independent domains continue converging and
  the release targets 15 minutes after the blocked domain is resolved.
- A simple injected packaging, test-oracle, or metadata failure produces a
  correct classification and focused reproduction within 3 minutes.
- Ordinary CI wall time does not regress; browser feedback becomes earlier.
- Every product-behavior release completes the selected automated and Computer
  Use preparation gate before any public mutation.
- Independent Computer Use scenarios run on separately owned isolated Desktops;
  one failure preserves its evidence without restarting unrelated lanes.
- Local balanced Playwright lanes have unique runtime and evidence resources,
  build once, fail closed on occupied ports/displays, clean only owned process
  groups, and retain failed-lane evidence.
- Release contains no duplicate ordinary repository gate.
- Every published asset and npm `gitHead` identifies the exact candidate SHA.
- npm is absent until the GitHub Release and required assets are public and
  verified.
- The npm tarball published has the same digest as the tarball accepted by
  smoke.
- No Agent loop performs repeated status polling or more than three focused
  repetitions without an explicit nondeterminism hypothesis.

## Failure And Recovery

- A CI or preparation failure creates no tag, public GitHub Release, or npm
  version.
- An ambiguous public mutation is reconciled from GitHub or npm authoritative
  state before retry.
- A GitHub Release published successfully before an npm failure remains a valid
  downloadable release; a rerun publishes npm only after verifying the same SHA
  and asset digests.
- An existing tag or npm version owned by another SHA is a terminal conflict and
  is never overwritten.
