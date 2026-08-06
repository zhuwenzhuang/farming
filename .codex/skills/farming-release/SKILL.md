---
name: farming-release
description: Prepare, test, diagnose, and complete Farming releases with exact-SHA evidence, automated and parallel Computer Use preparation gates, bounded investigation, parallel domain convergence, GitHub-before-npm publication, and measured 10/15-minute targets. Use when asked to prepare, validate, troubleshoot, publish, resume, or review a Farming version release, release candidate, CI gate, human acceptance scenario, package artifact, GitHub Release, or npm publication.
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
- `../../../docs/products/code/computer-use.md` when Computer Use is selected

Preserve unrelated worktree changes. Bind every decision to an exact version,
commit SHA, workflow run, and artifact digest.

## Start The Campaign

1. Record the start timestamp immediately.
2. Run `scripts/release-snapshot.sh VERSION` once. Do not reconstruct the same
   state with repeated `git status`, `gh run list`, or `npm view` calls.
3. Reject ambiguous version, SHA, branch, notes, tag, npm ownership, or dirty
   release inputs before any public mutation.
4. Inspect changed behavior, owning state contracts, tests, and recent failure
   signatures. Create one release-preparation plan before running broad gates.
5. Verify the selected remote branch identifies the same exact candidate SHA;
   push the intentional candidate commit before starting remote preparation.
6. Create a short unique campaign ID. Run
   `scripts/set-release-acceptance-status.sh pending VERSION CAMPAIGN_ID SHA`
   and pass its `acceptance_context` output when dispatching `release.yml`.
   This lets artifact preparation start immediately while preventing publication
   before automated and Computer Use acceptance succeeds.
7. Create a domain ledger with these rows:

| Domain | Required evidence |
| --- | --- |
| repository | exact-SHA check and Node compatibility |
| browser | Chromium, mobile, and selected focused interaction gates |
| provider | live real-provider baseline or required cross-runtime composite |
| computer-use | selected scenario lanes, Agent/Desktop identities, evidence, and invalidation status |
| candidate workflows | every push-triggered workflow for the exact SHA, including Documentation when selected by its path filter |
| linux | CLI, app bundle, legacy bundle, verify, and smoke |
| macos | native x64/arm64 CLI and app-bundle verify and smoke |
| npm | one tarball, digest, offline install, ACP/capability/server/PTY smoke |
| publication | notes, manifest, tag, public assets, checksums, npm `gitHead` |

Track each domain as `unknown`, `running`, `green`, `blocked`, or `stale`, plus
the tested SHA and failure signature.

## Treat Testing As The Release Preparation Gate

Testing is part of the release campaign, not optional work before the campaign.
Do not create a tag, public GitHub Release, or npm version until the mandatory
release-preparation ledger is green.

Start all reversible preparation together:

- exact-SHA CI and focused deterministic tests;
- Linux and macOS artifact build, verify, and smoke;
- construction and smoke of the one npm tarball that may later be published;
- automated real-provider and production-shaped browser gates;
- selected Computer Use lanes on isolated Desktops;
- reversible manifest, checksum, and release-note assembly.
- monitoring of every workflow triggered by the candidate push, not only CI and Release.

Budget the complete parallel preparation fan-out at seven minutes so the serial
GitHub and npm publication tail can finish inside the ten-minute campaign.

### Monitor Every Candidate Workflow

After pushing the exact candidate, immediately run
`scripts/watch-candidate-workflows.sh SHA` beside the other preparation lanes.
It discovers every `push` workflow for that SHA and fails on any non-successful
terminal result. Do not make the user discover a red workflow or deployment in
the repository UI after the release session.

Candidate-triggered workflows are required by default. A workflow may be
non-blocking only when the coordinator records an explicit domain proof that
its triggering change is outside the release scope. A historical failure from
another SHA must be reported but does not block the candidate.

When a candidate push triggers `Documentation`, its Pages deployment is part of
the required documentation domain. Keep release acceptance pending and do not
publish npm until it succeeds. The workflow bounds a Pages queue wait at three
minutes, so a stuck `deployment_queued` state becomes actionable during the
campaign. Classify it as an external provider failure, retain the first log and
deployment state, and continue independent lanes. Do not hide it by increasing
the timeout or repeatedly rebuilding the same documentation artifact.

## Separate Automation From Computer Use

Do not call Playwright a Computer Use test. Use both surfaces deliberately.

### Automated interaction gates

Record selected and omitted scenarios with reasons. Select by changed behavior
and owning contracts rather than filenames alone.

Use these levels:

| Level | When | Gate |
| --- | --- | --- |
| live baseline | every release | `npm run test:pre-release:codex-ui:smoke`; one real Codex Terminal, one visible turn, authoritative live session evidence; target 90 seconds |
| focused automation | behavior or UI changed | the smallest owning Playwright or product smoke that proves the affected state boundary; target 2-4 minutes per domain |
| real-provider composite | lifecycle, provider adapter/pin, shared protocol, Code/CRT switching, Terminal transcript/resize, or multiple interacting runtime domains changed | `npm run test:pre-release:codex-ui`; target no more than 7 minutes on the release critical path |

Run independent automated gates in parallel with CI, artifacts, and Computer
Use. The real-provider composite subsumes the live baseline; never run both.

### Parallel Computer Use lanes

Use `ssh4` as the environment label for the remote Linux host that provides
parallel Docker Isolated Desktops. Resolve `ssh4` through the operator's private
local environment mapping. Never commit or print its resolved hostname, user,
port, credentials, or private configuration.

Before the timed fan-out, verify that `ssh4` can provide the required capacity,
Docker is healthy, and the exact pinned Computer image is already present. A
cold image pull is an infrastructure miss, not acceptable release critical-path
work.

Create one Farming Agent and one owned Computer Resource per selected lane.
Every lane must have its own Desktop container, browser profile, workspace or
fixture identity, and evidence directory. Load the same exact candidate SHA in
every lane. Actions inside a lane are sequential; independent lanes run in
parallel.

Use a cost-efficient vision-capable model with enough reasoning quality for
routine Computer Use test Agents. Select by capability and measured reliability,
not by one hard-coded model name: suitable choices may include Luna Max or a
qualified Qwen Max/open-source vision model. The selected model must reliably
interpret screenshots, follow bounded UI scenarios, distinguish uncertain
actions from confirmed state, and return structured evidence. Record the model
and configuration in the lane evidence. Reserve the release coordinator's
stronger or more expensive model for orchestration, case-design review, and
centralized failure diagnosis.

A lane Agent must execute a bounded scenario, capture evidence, and stop; it
must not perform open-ended investigation, redesign the product, or repeat broad
tests. On failure, return the first stable signature and retained evidence to
the coordinator. Escalate from the economical vision model only when it cannot
reliably perceive or execute the scenario, or when the scenario explicitly
verifies another model or provider; record the reason in the domain ledger.

Keep token use bounded: do not create more Agent lanes than selected scenarios,
do not ask several Agents to diagnose the same failure, and do not duplicate an
automated assertion in Computer Use unless the real Desktop interaction is the
contract being verified.

Select Computer Use lanes at three levels:

| Level | Required use | Expected lane |
| --- | --- | --- |
| sanity | every product-behavior release unless a stronger lane subsumes it | open the exact candidate and complete one normal user-visible action |
| focused domain | each changed user behavior | complete the shortest end-to-end user journey through the changed UI, backend owner, and terminal success or rejection |
| continuity composite | shared lifecycle/protocol, session identity, runtime switching, or interacting domains changed | keep one Session coherent through all affected transitions in one Desktop |

Use separate focused lanes for independent domains such as sharing/access,
Chat/ACP, Terminal, CRT, Browser/Computer, and responsive appearance. Native
macOS Desktop/LSP acceptance cannot be replaced by Linux containers; schedule a
Mac lane when that contract changes.

For each lane record candidate SHA, scenario, Agent ID, Computer Resource ID,
container/image identity, start/end time, screenshots, Computer action trace,
backend/provider evidence, result, and stable failure signature. Clean up exact
successful resources. Preserve a failed Desktop only while its bounded
investigation uses it, then remove that exact resource.

When every required automated and Computer Use lane is green, run
`scripts/set-release-acceptance-status.sh success VERSION CAMPAIGN_ID SHA`.
Post `failure` or `error` for a terminal acceptance outcome. Never post success
while a required lane is unknown, running, blocked, or stale. The Release
workflow must wait for this exact context before creating a tag or Release.

### Behavior-to-scenario mapping

Apply the same mapping to automated gates and Computer Use lanes:

- Chat/ACP, queue, steer, resume, or transcript changes select a Chat story.
- PTY, input, output, reconnect, renderer, or resize changes select a Terminal story.
- CRT or skin changes select the affected CRT story.
- runtime switching, provider session identity, shared lifecycle, or provider
  adapter/pin changes select the cross-domain composite.
- sharing, authentication, read-only, or WebSocket access changes select an
  owner-to-guest story including reconnect and a rejected mutation.
- Browser, Computer, Desktop, LSP, package installation, or update changes
  select their own focused installed/product-surface story.
- appearance or responsive-layout changes select the affected story at the
  changed theme and viewport; they do not select unrelated runtime stories.

Do not run a composite merely because it exists. Do not omit one when a listed
cross-domain trigger applies.

## Converge A Failed Preparation Lane

One failure does not authorize rerunning every automated or Computer Use gate.

1. Freeze the failed lane and retain its first trace, screenshots,
   provider/backend logs, exact user action, and authoritative state transition.
   Do not rerun a broad gate on the same SHA merely to see the error again.
2. Audit the failed case before calling it flaky or blaming product code. Verify
   that it proves one coherent product contract, its environment and fixtures
   satisfy the contract's prerequisites, it reaches state through the real
   product path unless an isolated fixture is intentional, it waits for the
   authoritative network/state/animation boundary, and it does not chain
   unrelated domains whose earlier state can pollute later assertions. A case
   that violates these rules is a test-design defect: repair or split the case
   before using it as release evidence. A passing retry does not make an
   unreasonable case green.
3. Reduce the failure to the exact story, mode, viewport, provider, and state
   boundary. Identify the changed file or commit that introduced it when the
   evidence permits.
4. Within three minutes, name the authoritative owner and violated invariant.
   For lifecycle failures, write the minimal owner, trigger, guard, effect,
   terminal failure, retry/cancellation, concurrency, and recovery model before
   editing.
5. Fix the invariant at its owning architectural boundary. If the product
   contract is correct and the case is not, fix the case design rather than
   weakening the product or assertion. Do not hide uncertain
   state with retries, longer timeouts, fallback values, or UI-only compensation.
6. Run the focused scenario once after the fix. Use up to three repetitions only
   for an explicit nondeterminism hypothesis that names the suspected varying
   state and the evidence each repetition will collect. Never use retries as the
   first diagnostic action.
7. Keep independent lanes running and retain their results. Mark only lanes
   whose inputs, shared contracts, or user journey changed as `stale`.
8. Rerun exact-SHA CI, artifacts, npm tarball smoke, and the live provider
   baseline for the final candidate. Rerun only stale Computer Use lanes.
   Unaffected Computer Use evidence may be carried forward only with an explicit
   diff-based invalidation proof; record its original SHA and never describe it
   as exact-SHA artifact evidence.

## Select One Operating Scenario

### Standard

Use when there is no known blocker. Run the complete release-preparation gate,
including selected automated and Computer Use lanes, in parallel. Finish GitHub
publication, public asset verification, npm publication, and npm verification
within 10 minutes total.

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
- After the blocked domain is resolved, run the complete final exact-SHA machine
  pipeline plus every stale Computer Use lane.
- Finish the remaining release within 10 minutes after resolution.

Earlier domain results remove unknowns and warm deterministic caches. They never
replace final exact-SHA gates or justify publishing old-SHA artifacts.

## Diagnose In Three Minutes

For the first required failure:

1. In 30 seconds, identify the exact failed job, step, test, first error, changed
   files, owner boundary, case contract, prerequisites, and failure signature.
2. By 90 seconds, inspect the retained trace, network response, state transition,
   and case setup. Decide whether the case itself mixes independent stories,
   bypasses the product state path, samples a transition, or assumes an invalid
   environment. Run one smallest focused reproduction only when evidence is
   still missing.
3. By 180 seconds, state the violated invariant and classify the failure as
   product logic, test design/oracle/lifecycle, packaging manifest, workflow
   dependency, environment/provider, or known recurrence. Do not classify a
   test as unstable merely because retries fail at different lines; that pattern
   often proves the case contains multiple invalid or unsynchronized assertions.
4. Fix a simple defect minimally. Escalate a design defect to `Domain blocked`.

Run a focused test once. Repeat at most three times only when the explicit
hypothesis is nondeterminism. If two fixes under one hypothesis fail, stop
editing and add one-time state-transition instrumentation. Do not make a third
guess without a revised root-cause model.

Run the owning focused check while editing, then one complete gate. Do not run
typecheck, lint, build, full tests, and remote CI after every small edit.

## Run And Monitor Automation

- Start reversible CI, platform builds, npm tarball preparation, automated
  interaction gates, and remote Computer Use lanes in parallel.
- Do not serialize artifact preparation behind the CI wait.
- Use one coordinator ledger for `ssh4` Computer Use lanes. Do not make the user
  inspect several Agent conversations to learn whether preparation is complete.
- Use `scripts/watch-candidate-workflows.sh SHA` to monitor all workflows from
  the candidate push. Do not infer repository health from CI alone.
- Dispatch `release.yml` with both `release_version` and the exact
  `acceptance_context` created for this campaign.
- Fail fast per lane, not per campaign. Let independent lanes converge while the
  failed lane produces actionable evidence.
- Use `scripts/watch-run.sh RUN_ID` for a GitHub Actions run. Do not manually poll
  it from the model.
- On failure, use the script's failure bundle and begin diagnosis immediately;
  do not wait for unrelated successful jobs.
- Cancel obsolete candidate runs after a replacement SHA is pushed.

## Enforce Publication Safety

Before dispatching or resuming publication, verify the workflow contract:

- the mandatory release-preparation ledger is green or has an explicitly
  accepted carried-forward Computer Use result with invalidation proof;
- exact-SHA full CI and every required artifact smoke gate completed before
  publication;
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

1. mandatory preparation completed: final exact-SHA CI, artifacts, package and
   provider gates succeeded, every required candidate-triggered workflow is
   green, and every selected Computer Use lane is green or validly carried
   forward;
2. GitHub tag targets the final SHA;
3. GitHub Release is public and required assets can be downloaded and verified;
4. npm version exists only after step 3;
5. npm `gitHead` equals the final SHA and the published tarball digest equals the
   smoke-accepted digest.

Report the total elapsed time, selected scenario, time spent in diagnosis,
number of candidate cycles, selected/omitted Computer Use lanes, `ssh4` lane
wall time and capacity, domain ledger result, workflow critical path, and any
missed objective. Do not exclude bug-fixing time from the total.
