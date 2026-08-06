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

### B2. Balance browser shards without changing test isolation

- Increase file-level Chromium sharding from ten to twelve so the previous
  terminal-heavy shard no longer also owns the cross-skin and link groups.
- Preserve one-worker and file-level isolation; do not enable unproven
  fully-parallel execution inside stateful scenario files.
- Split oversized scenario files along lifecycle boundaries if measured shard
  imbalance remains after dependency-install waste is removed.

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
10. Use the next patch version as a production-shaped timed release test.

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
