---
name: farming-release
description: Prepare, diagnose, and complete Farming releases with exact-SHA evidence, bounded investigation, parallel domain convergence, GitHub-before-npm publication, and measured 10/15-minute targets. Use when asked to prepare, validate, troubleshoot, publish, resume, or review a Farming version release, release candidate, CI gate, package artifact, GitHub Release, or npm publication.
---

# Farming Release

Use one measured release campaign from the user's release request through npm
verification. Include investigation, fixes, retries, queueing, CI, builds, and
publication in elapsed time. Never reset the campaign clock after a failure.

Before acting, read:

- `../../../docs/development/release-pipeline-acceleration-plan.md`
- `../../../.github/workflows/ci.yml`
- `../../../.github/workflows/release.yml`
- the release scripts and package scripts invoked by those workflows

Preserve unrelated worktree changes. Bind every decision to an exact version,
commit SHA, workflow run, and artifact digest.

## Start The Campaign

1. Record the start timestamp immediately.
2. Run `scripts/release-snapshot.sh VERSION` once. Do not reconstruct the same
   state with repeated `git status`, `gh run list`, or `npm view` calls.
3. Reject ambiguous version, SHA, branch, notes, tag, npm ownership, or dirty
   release inputs before any public mutation.
4. Create a domain ledger with these rows:

| Domain | Required evidence |
| --- | --- |
| repository | exact-SHA check and Node compatibility |
| browser | Chromium and mobile interaction gates |
| linux | CLI, app bundle, legacy bundle, verify, and smoke |
| macos | native x64/arm64 CLI and app-bundle verify and smoke |
| npm | one tarball, digest, offline install, ACP/capability/server/PTY smoke |
| publication | notes, manifest, tag, public assets, checksums, npm `gitHead` |

Track each domain as `unknown`, `running`, `green`, `blocked`, or `stale`, plus
the tested SHA and failure signature.

## Select One Operating Scenario

### Standard

Use when there is no known blocker. Run full CI, platform artifact preparation,
and npm tarball preparation in parallel. Finish GitHub publication, public asset
verification, npm publication, and npm verification within 10 minutes total.

### Quick fix

Use for a bounded metadata, packaging-manifest, test-oracle, or small product
defect. Run the changed-area fast screen beside the full pipeline. Target:

- first actionable failure within 2 minutes;
- classification, focused reproduction, and minimal fix within 3 minutes;
- corrected full pipeline within the remaining 10 minutes;
- total campaign within 15 minutes, without resetting the timer.

If the failure appears late, record the missed target and add its stable
signature and focused command to the fast screen before considering the release
process repaired.

### Domain blocked

Use when the defect requires a state-machine, ownership, ordering, protocol, or
architecture change. Decide this escalation within 3 minutes.

- Mark the affected domain `blocked`.
- Continue testing and fixing every independent domain.
- Do not let the blocked domain turn unrelated domains back into `unknown`.
- Mark domains `stale` when the blocker fix changes their inputs or contracts.
- Record the full design-resolution time.
- After the blocked domain is resolved, run the complete final exact-SHA pipeline.
- Finish the remaining release within 10 minutes after resolution.

Earlier domain results remove unknowns and warm deterministic caches. They never
replace final exact-SHA gates or justify publishing old-SHA artifacts.

## Diagnose In Three Minutes

For the first required failure:

1. In 30 seconds, identify the exact failed job, step, test, first error, changed
   files, owner boundary, and recurring failure signature.
2. By 90 seconds, run one smallest focused reproduction or inspect the retained
   trace and logs.
3. By 180 seconds, state the violated invariant and classify the failure as
   product logic, test oracle/lifecycle, packaging manifest, workflow dependency,
   environment/provider, or known recurrence.
4. Fix a simple defect minimally. Escalate a design defect to `Domain blocked`.

Run a focused test once. Repeat at most three times only when the explicit
hypothesis is nondeterminism. If two fixes under one hypothesis fail, stop
editing and add one-time state-transition instrumentation. Do not make a third
guess without a revised root-cause model.

Run the owning focused check while editing, then one complete gate. Do not run
typecheck, lint, build, full tests, and remote CI after every small edit.

## Run And Monitor Automation

- Start reversible CI, platform builds, and npm tarball preparation in parallel.
- Do not serialize artifact preparation behind the CI wait.
- Use `scripts/watch-run.sh RUN_ID` for a GitHub Actions run. Do not manually poll
  it from the model.
- On failure, use the script's failure bundle and begin diagnosis immediately;
  do not wait for unrelated successful jobs.
- Cancel obsolete candidate runs after a replacement SHA is pushed.

## Enforce Publication Safety

Before dispatching or resuming publication, verify the workflow contract:

- exact-SHA full CI and every required artifact smoke gate publication;
- ordinary repository checks are not repeated in Release jobs;
- the npm tarball is built once and the same digest is smoked and published;
- GitHub Release is public and required assets are verified before npm starts;
- npm is the last public mutation;
- tag, manifest, artifacts, GitHub Release, and npm `gitHead` identify one SHA.

If the checked-in workflow violates these invariants, fix and verify the
workflow before publishing. Never use the current unsafe order merely because it
already exists.

Treat mutation timeout or transport failure as an uncertain outcome. Reconcile
GitHub or npm authoritative state before retrying. Never replay an npm publish
blindly.

## Complete The Campaign

Verify, in order:

1. final exact-SHA CI and every domain gate succeeded;
2. GitHub tag targets the final SHA;
3. GitHub Release is public and required assets can be downloaded and verified;
4. npm version exists only after step 3;
5. npm `gitHead` equals the final SHA and the published tarball digest equals the
   smoke-accepted digest.

Report the total elapsed time, selected scenario, time spent in diagnosis,
number of candidate cycles, domain ledger result, workflow critical path, and
any missed objective. Do not exclude bug-fixing time from the total.
