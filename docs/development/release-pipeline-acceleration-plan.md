# Release, Test Feedback, And Diagnosis Efficiency Plan

> Chinese version: [release-pipeline-acceleration-plan.zh_cn.md](./release-pipeline-acceleration-plan.zh_cn.md)

Status: Implementing and measuring

This plan improves one end-to-end path: a maintainer asks to release a version,
the exact candidate is checked, any blocker is diagnosed and fixed, publishable
artifacts are verified, GitHub Release becomes publicly usable, and only then is
the npm package published.

The plan does not remove investigation or bug-fixing time from the measurement.
The clock starts when the release request is accepted and does not reset after a
failure or a fix.

## Objectives

- Normal end-to-end release elapsed time: less than 10 minutes.
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

If any release exceeds 10 minutes, the complete elapsed time still counts. The
result is a missed objective with an exact attribution to investigation, CI,
artifact preparation, publication, queueing, or an external provider. It is not
reclassified as development time.

## Three Operating Scenarios

### Scenario 1: No blocker

The exact candidate has no newly discovered defect. Full CI, release artifact
preparation, and npm package smoke run in parallel. GitHub Release is published
and verified before npm. The complete path must finish within 10 minutes.

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
release must finish within 10 minutes.

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

The middle fan-out has a seven-minute wall-time budget. GitHub publication,
public verification, and npm publication remain serial and consume the remaining
budget.

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

This rule was added after Documentation run `#18` on 2026-08-06 built and
uploaded its artifact in 28 seconds but remained `deployment_queued` for the
full ten-minute action timeout. A deploy-only retry and a fresh 23-second build
both reproduced the queue stall. The candidate-wide monitor now discovers this
domain automatically, while the workflow makes the external failure terminal
within three minutes.

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

### Component timing validation on 2026-08-06

The layered gates were exercised independently before the next exact release:

| Component | Measured wall time |
| --- | ---: |
| Final local `npm run check`, 303/303 tests green | 1 min 51.03 sec |
| Focused sharing Playwright, including local build/start | 15.20 sec |
| Real-Codex live baseline, including local build/start | 15.43 sec |
| Full real-provider Code/CRT/Terminal composite | 2 min 11.42 sec |
| Four isolated Linux Desktops started in parallel to healthy | 12.809 sec |

The remote Desktop measurement ran while five existing Computer containers
remained healthy, and every timing container was removed afterward by exact
identity. It proves pool startup and parallel capacity, not the duration of a
multi-Agent Computer Use journey. That end-to-end lane time must be measured on
the next exact candidate deployment and included in the release campaign.

### Current end-to-end status on 2026-08-06

The current normal-release estimate is:

```text
about 20 sec candidate selection and dispatch
+ max(exact-SHA CI, artifacts, automated interaction, Computer Use)
+ about 2 min serial GitHub verification and npm publication
```

The latest complete end-to-end release, v2.2.45, took 10 minutes 4 seconds with
exact-SHA CI at 7 minutes 47 seconds and all artifacts ready at 4 minutes 26
seconds. The new automated interaction gates are below that critical path: the
heaviest measured composite is 2 minutes 11.42 seconds.

If the slowest parallel Computer Use lane finishes within seven minutes, the
expected normal release remains approximately 9 minutes 30 seconds to 10
minutes. This is the current operating estimate, not yet a proven new
end-to-end result. The next exact candidate must measure the complete multi-Agent
Computer Use fan-out and publication path before the ten-minute objective is
considered demonstrated.

## v2.2.41 Baseline

The afternoon release session ran from 13:22 to 17:20. Six CI runs consumed 90
minutes, two Release runs consumed 23 minutes, and local review, diagnosis, and
fixing consumed about 127 minutes.

| Time | Event | Duration |
| --- | --- | ---: |
| 13:22–13:56 | Review 32 changed files and create the first candidate | 34 min |
| 13:56–14:00 | CI finds five backend test failures | 4 min |
| 14:00–14:08 | Fix package-image validation | 8 min |
| 14:09–14:25 | CI finds a browser-test failure | 17 min |
| 14:25–14:31 | Fix transcript-focus test setup | 5 min |
| 14:31–14:48 | CI finds persisted-anchor failure | 17 min |
| 14:48–15:17 | Change anchor restoration and tests | 29 min |
| 15:18–15:35 | CI succeeds | 17 min |
| 15:35–15:40 | Release finds missing Computer schema in native CLI | 5 min |
| 15:40–15:46 | Fix native CLI packaging | 6 min |
| 15:47–16:04 | CI exposes the persisted-anchor failure again | 18 min |
| 16:05–16:44 | Correct the test lifecycle and oracle | 39 min |
| 16:44–17:01 | Final CI succeeds | 17 min |
| 17:02–17:20 | Final Release succeeds | 19 min |

The final successful Release workflow took 18 minutes 39 seconds:

| Stage | Observed duration |
| --- | ---: |
| Candidate preflight | 8 sec |
| macOS arm64 artifacts | 2 min 40 sec |
| macOS x64 artifacts | 5 min 5 sec |
| Linux artifacts | 9 min 22 sec |
| npm job | 6 min 59 sec |
| Stage GitHub Release | 1 min 42 sec |
| Publish GitHub Release | 5 sec |

## v2.2.42 Timed Result And Second-Pass Findings

The first accelerated candidate used SHA
`e4afb2fd261746cdf5baed3207911a4aab467ca6`. Exact-SHA CI completed in
9 minutes 17 seconds. The GitHub Release became public after 16 minutes 8
seconds; npm remained unpublished because its final job failed closed.

| Critical path | Observed duration | Direct cause |
| --- | ---: | --- |
| CI | 9 min 17 sec | Chromium shard 9 ran tests for 6 min 3 sec; iPhone WebKit spent 3 min 54 sec in `npm ci` |
| Linux artifacts | 10 min 21 sec | CLI, standard app, and legacy app build and smoke were serialized |
| macOS x64 artifacts | 7 min 12 sec | CLI and app work were serialized |
| macOS arm64 artifacts | 13 min 55 sec | `npm ci` took 5 min 23 sec and app extraction plus smoke took 4 min 6 sec |
| Stage GitHub Release | 1 min 37 sec | dependency installation took 30 sec and manifest generation hashed large assets twice |
| npm publication | failed in 13 sec | npm 12 interpreted a tarball path without `./` as a GitHub package specifier (`EALLOWGIT`) |

The macOS arm64 install log identified the main installation waste rather than
runner queueing: repository `npm ci` invoked Farming's installed-package
postinstall, downloaded Claude Code and agent-browser into an approximately
846 MB throwaway runtime seed, and retried a slow mirror before the public npm
registry. Source CI and release build checkouts do not consume that seed.

The second pass therefore applies these concrete changes together:

- source CI and release preparation skip installed-package runtime seeding;
- Linux CLI, standard app, and legacy app are independent parallel jobs;
- macOS CLI and app packaging are independent jobs for each architecture;
- app smoke runs against the exact retained assembly directory, avoiding a
  compress-then-extract cycle before testing;
- already compressed release assets use artifact compression level zero;
- manifest generation reuses the generated checksums instead of hashing every
  large asset twice;
- Chromium uses twelve file-level shards and uploads traces, screenshots, and
  reports only on failure;
- npm publication uses an explicit relative tarball path.

## v2.2.43 Timed Result And Third-Pass Changes

The v2.2.43 campaign completed successfully from exact candidate acceptance to
npm verification in 12 minutes 41 seconds. Release artifact preparation was no
longer the critical path: every platform and npm artifact was verified within
4 minutes 52 seconds. Exact-SHA CI and the publication tail remained.

| Remaining work | Observed duration or delay |
| --- | ---: |
| All reversible release artifact preparation | 4 min 52 sec |
| Exact-SHA CI | 8 min 38 sec |
| Chromium shard 3 queue delay at the measured 20-job account ceiling | 2 min 5 sec |
| Slowest Chromium test execution | 6 min 15 sec |
| Stage GitHub Release | 1 min 23 sec |
| npm publication and `gitHead` visibility | 1 min 15 sec |

The next pass fits the workflow to the measured remote capacity instead of
creating more queued jobs:

- nine Chromium jobs use balanced single-worker assignment, distributing 344
  tests as 39/39/38/38/38/38/38/38/38;
- the dedicated CI-wait job is removed, freeing one hosted runner slot;
- release staging downloads and hashes already verified assets while CI
  finishes, then checks exact-SHA CI immediately before tag/draft creation;
- verified app `RELEASE.json` sidecars replace re-reading four large compressed
  archives during manifest generation;
- npm publication suppresses the 20,000-file notice listing and avoids an
  unnecessary global npm upgrade in the publication job.

## v2.2.44 Timed Result And Fourth-Pass Changes

The v2.2.44 campaign made the GitHub Release publicly usable and verified in
9 minutes 48 seconds, but npm publication failed closed at 11 minutes 6
seconds. CI still took 8 minutes 30 seconds.

Two exact causes remained:

- Playwright's built-in fully-parallel sharding balances test count by
  contiguous list ranges. Shard 6 received 20 adjacent Pet tests and became the
  6 minute 50 second job, while other shards finished much earlier.
- Removing the npm CLI upgrade exposed runner npm 10, which cannot complete the
  repository's current OIDC Trusted Publishing path and returned a registry PUT
  404 after 50 seconds. npm 12 is therefore a required publication dependency,
  not removable setup waste.

The fourth pass restores npm 12 and replaces contiguous Playwright sharding
with a repository script that discovers exact test locations and stripes
adjacent location groups across nine shards. Each shard remains one worker;
generated tests sharing one source location remain atomic.

## v2.2.45 Timed Result And Fifth-Pass Changes

The corrected v2.2.45 candidate completed exact-SHA CI in 7 minutes 47
seconds and the complete GitHub-plus-npm release in 10 minutes 4 seconds. All
release artifacts were ready in 4 minutes 26 seconds, so platform packaging was
not the critical path. The quick-fix campaign, including the first failed
candidate, took 15 minutes 24 seconds.

The remaining four-second miss came from two concrete tails:

- Chromium shard 4 ran for 6 minutes 10 seconds even though every shard had 38
  or 39 tests. A measured run showed one test at about 75 seconds and several
  at 12 to 21 seconds, proving that test-count balance was not duration balance.
- CI completion was followed by three separately scheduled Jobs for GitHub
  publication, public verification, and npm publication. Their repeated runner
  setup and scheduling added avoidable latency after all reversible work was
  already complete.

The fifth pass uses measured location-duration weights and longest-processing-
time assignment across the existing nine single-worker Chromium Jobs. The
predicted shard loads are now 266 to 273 seconds without adding CI work or
remote concurrency. It also keeps staging, GitHub publication, public asset
verification, and npm publication in one Job. npm setup and tarball download
occur while exact-SHA CI is still running; npm publication remains the final
step after public GitHub verification.

The repository now provides `scripts/release-snapshot.sh` for one initial
candidate snapshot and `scripts/watch-run.sh` for script-owned monitoring and a
bounded failure bundle. This removes the need for repeated Agent polling.

## v2.2.55 Retrospective And Artifact-Reuse Change

The v2.2.55 campaign took 6 hours 46 minutes 12 seconds from request to npm
verification, while the final accepted candidate needed only 7 minutes 40
seconds to publish. Candidate preparation and defect convergence dominated the
campaign, but the workflow also rebuilt all platform and npm artifacts whenever
candidate-workflow or Computer Use acceptance arrived after the publication
job's bounded wait.

The two observed publication attempts exposed the avoidable retry cost:

- one attempt waited 8 minutes for candidate workflows and then failed;
- one attempt waited 10 minutes for Computer Use acceptance and then failed;
- each retry rescheduled and rebuilt roughly 5 minutes of already verified
  Linux, macOS, and npm artifacts before publication could resume.

Release preparation and publication are now separate workflows. `release.yml`
builds, verifies, smokes, and stores the exact artifacts once.
`publish-release.yml` accepts only a successful preparation run whose workflow
path and `head_sha` match the full candidate SHA, downloads artifacts from that
exact run, checks candidate push workflows and release acceptance once, then
preserves the GitHub-public-verification-before-npm order. A late acceptance or
publication retry therefore reuses verified artifacts instead of repeating the
platform fan-out.

The repository also provides `npm run release:fast-screen`. Its independent
release metadata, dependency policy, Browser lifecycle, ACP replacement,
packaging identity, and workflow-contract gates run in parallel. On 2026-08-20
the eight-gate screen completed locally in 3.06 seconds, well below the two-minute
early-feedback target.

## Confirmed Sources Of Waste

### Agent investigation

- Before the first push, the Agent ran typecheck, lint, build, and npm smoke,
  but did not run the exact ordinary CI gate, `npm run check`. CI then found five
  backend failures that were locally discoverable.
- The persisted-anchor scenario was executed locally with repeat counts of 3,
  10, 10, and 15. Repetition replaced a single state-transition trace.
- The afternoon session issued 31 `gh run view`, 14 `gh run list`, 8
  `gh run watch`, 51 `git diff`, 24 `git status`, 7 typechecks, and 7 lint runs.
- Remote CI was repeatedly used to obtain the next diagnostic fact instead of
  certifying a locally understood fix.

### CI feedback

- Browser shards cannot start until the `Check` job completes, although the
  frontend build itself took only 11 seconds. They wait behind about 4 minutes
  of repository checks.
- Chromium shard 2 spent about 10 minutes in browser tests. Large spec files are
  indivisible because Playwright uses `fullyParallel: false`, so six shards are
  not balanced effectively.
- Failed tests retry twice in CI. This is useful for evidence, but the first
  failure is not packaged immediately into a concise diagnostic result.

### Release workflow

- Exact-SHA CI already ran `npm run check`, but Linux artifact construction ran
  it again for 3 minutes 58 seconds and the npm job ran it a third time for 3
  minutes 23 seconds.
- CLI, normal app-bundle, and legacy app-bundle scripts rebuild frontend/runtime
  output separately.
- npm smoke builds one tarball, deletes it, and publication builds another.
- Artifact preparation waits for full CI instead of running reversibly in
  parallel with CI.
- npm is currently published before the GitHub Release is created and made
  public.
- Agent monitoring repeatedly polls GitHub instead of returning one terminal
  failure bundle.

## Target End-To-End Flow

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

## Workstream A: Release Pipeline

### A1. Split metadata validation from the CI gate

- A fast metadata job validates version, lockfile, release notes, branch, tag,
  and npm-version conflicts.
- The exact-SHA CI gate continues to wait for the required CI run.
- Platform builds and npm preparation depend only on metadata validation, so
  they run in parallel with the CI gate.
- Public GitHub and npm jobs depend on both the CI gate and all preparations.

### A2. Remove repeated repository checks

- Remove `npm run check` from Linux artifact construction and npm publication.
- Keep exact-SHA CI as the authoritative repository gate.
- Keep every platform-, package-, architecture-, and runtime-specific verify
  and smoke step.

This removes 7 minutes 21 seconds from the current Release critical path
without reducing coverage.

### A3. Parallelize independent packages and retain exact assembly output

- Run Linux CLI, standard app-bundle, and legacy app-bundle as three parallel
  jobs after one metadata gate.
- Run native CLI and app-bundle as two parallel jobs for each macOS architecture.
- Retain the exact app assembly directory until smoke completes. Verify the
  archive and smoke the retained directory instead of extracting the large
  archive immediately after creating it.
- Keep all jobs reversible until exact-SHA CI and every package-specific gate
  are green.

### A6. Separate source installation from product installation

- Source CI and release build checkouts set
  `FARMING_SKIP_INSTALL_RUNTIME_PREPARE=1`; they build and test source directly
  and must not create a package-installation runtime seed.
- npm package smoke and app-bundle construction retain their installation-form
  runtime requirements. This optimization does not weaken the published
  installation contract.
- Browser downloads remain explicit workflow steps, so dependency installation
  does not silently download a second browser copy.

### A4. Smoke and publish one npm tarball

- Extend npm package smoke to accept or export an explicit tarball path.
- Compute the tarball SHA-256 before smoke and after workflow-artifact transfer.
- Publish that exact tarball directly. Publication must not run `prepack`,
  `npm pack`, or another production dependency installation.

### A5. Publish npm last

- Assemble a draft GitHub Release from verified assets.
- Publish the GitHub Release.
- Verify the public tag target, asset inventory, manifest, checksums, and at
  least one public asset download.
- Only after that verification, publish npm and reconcile its `gitHead`.

## Workstream B: Test And Failure Feedback

### B1. Start browser tests earlier

- Split frontend artifact production from the repository `Check` job.
- Run frontend production, `Check`, and Node compatibility in parallel.
- Browser and mobile jobs depend only on the frontend artifact job.
- Remove the old frontend build from `Check` so normal CI does not perform the
  build twice.

### B2. Balance browser shards without adding in-job concurrency

- Use nine Chromium shards to match the measured 20-job remote concurrency
  ceiling when release preparation is also active.
- Discover exact test locations once per job and assign atomic location groups
  by measured duration, using a bounded default when a location has no timing
  sample. Rebalance slow locations across the existing Jobs instead of adding
  workers or more remote Jobs.
- Keep exactly one worker per job. Generated tests sharing one source location
  remain atomic, and no backend receives concurrent tests.

### B3. Produce a failure bundle immediately

For the first required job failure, generate one machine-readable and
human-readable bundle containing:

- candidate SHA and changed files;
- failed workflow, job, step, test, and first error;
- exact focused reproduction command;
- trace, screenshot, and relevant server/browser logs;
- a stable failure signature used to detect recurrence.

The release watcher exits on the first terminal required-job failure and
returns this bundle. It does not require repeated Agent polling.

## Workstream C: Agent Diagnosis Protocol

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
| Metadata validation and scheduling | 20 sec |
| Full CI and all reversible artifact preparation, in parallel | 7 min |
| Assemble and publish GitHub Release | 40 sec |
| Verify public tag and assets | 30 sec |
| Publish the pre-smoked npm tarball and verify `gitHead` | 1 min |
| Variance reserve | 30 sec |
| Total | 10 min |

When a failure occurs, the clock continues. The three-minute diagnosis protocol
reduces avoidable investigation time; it does not reset the release timer.

## Implementation Sequence

1. Add workflow timing, exact-SHA identity, artifact digests, and the single
   failure-bundle watcher.
2. Remove the two duplicate `npm run check` executions.
3. Export, transfer, smoke, and publish one npm tarball.
4. Reverse public mutation order so GitHub Release is verified before npm.
5. Split metadata validation from the CI gate and run reversible preparation in
   parallel with CI.
6. Build staged runtime output once per runner and parallelize independent
   packages where needed.
7. Split frontend artifact production from `Check` and rebalance oversized
   Playwright specs.
8. Implement the three-minute diagnosis command and then encode the approved
   process in a repository Release Skill.
9. Add the domain ledger, affected-domain invalidation, and the three operating
   modes to the repository Release Skill.
10. Add the mandatory preparation ledger and parallel isolated-Desktop Computer
    Use coordination to the repository Release Skill.
11. Use the next patch version as a production-shaped timed release test.

## Acceptance Criteria

- Measurement starts at the accepted release request and includes every retry,
  investigation, fix, queue, CI run, build, and publication step.
- Normal end-to-end release completes in less than 10 minutes.
- A release with one simple blocker completes in less than 15 minutes.
- For a substantial design blocker, independent domains continue converging and
  the release completes within 10 minutes after the blocked domain is resolved.
- A simple injected packaging, test-oracle, or metadata failure produces a
  correct classification and focused reproduction within 3 minutes.
- Ordinary CI wall time does not regress; browser feedback becomes earlier.
- Every product-behavior release completes the selected automated and Computer
  Use preparation gate before any public mutation.
- Independent Computer Use scenarios run on separately owned isolated Desktops;
  one failure preserves its evidence without restarting unrelated lanes.
- Release contains no duplicate ordinary repository gate.
- Every published asset and npm `gitHead` identifies the exact candidate SHA.
- npm is absent until the GitHub Release and required assets are public and
  verified.
- The npm tarball published has the same digest as the tarball accepted by
  smoke.
- No Agent loop performs repeated status polling or more than three focused
  repetitions without an explicit nondeterminism hypothesis.
- The first five releases record full elapsed time and critical-path attribution.

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
