# Runtime dependency versions

> Chinese version: [runtime-dependencies.zh_cn.md](./runtime-dependencies.zh_cn.md)

Farming pins platform executables such as Codex, Claude Code, and
`agent-browser`. Each Farming release pins exact
versions, download integrity, executable entries, and supported platform keys.

## Temporary agent-browser source pin

All distribution forms carry `0.32.3-farming.1`, a Farming build of upstream
0.32.3 with the stderr-drain fix from [upstream PR #1527](https://github.com/vercel-labs/agent-browser/pull/1527).
The launch owner continuously consumes Chrome's piped stderr after endpoint
discovery, so a long-lived browser cannot block on a full, unread pipe. It does
not retain an unbounded diagnostic log or change Chrome itself.

**Do not upgrade agent-browser until an official release includes this fix.**
Before returning to an official build, verify the actual released source and
rerun the real-launch stderr saturation regression and Farming Browser smoke.
A newer version number alone is not sufficient. The source pin and reviewed
patch are authoritative; routine dependency updates must leave them unchanged.

Native construction progresses from exact upstream commit and checked patch to
launcher tests, dashboard-inclusive release build, and platform identity/digest.
Packagers accept only the selected Farming commit's complete native artifacts.
Missing, mismatched, or corrupt artifacts are terminal errors, never a reason to
download the unpatched npm executable. Runtime resolution verifies the bundled
identity and executable digest; standalone CLI snapshot assets are copied into
the existing immutable cache before execution. Abrupt loss during preparation
leaves no active binding; a later preparation validates or rebuilds the cache
under the existing dependency lock.

Source developers explicitly build with
`node scripts/build-agent-browser-runtime.mjs --platform <platform> --output <artifact-root>`,
then set `FARMING_AGENT_BROWSER_ARTIFACTS` to that root and run
`npm run prepare:packaged-runtimes -- --platform <platform>` after building the
frontend. Rust and pnpm versions are pinned in the source metadata. Releases
build every supported native platform before packaging; ordinary frontend and
unit-test builds do not silently compile or download a substitute Browser runtime.

## Runtime ownership by mode

Runtime selection has two independent consumers:

- Native Terminal resolution is system-first. It selects the user's system
  executable when available, and selects the verified Farming-owned executable
  only when the latter is strictly newer. Equal versions resolve to the system
  executable; no system candidate falls back to the Farming-owned runtime.
- ACP resolution is Farming-owned. Bundled ACP adapters and their provider
  runtimes use the exact Farming pin and do not inherit the Terminal-selected
  executable from the Server environment.

Runtime bindings and provider launch paths must preserve these two choices as
distinct sources; one `executablePath` must not silently serve both policies. ACP pins are updated
toward the latest compatible release and are accepted only after adapter patch,
integrity, protocol, and Chat/Terminal switching verification.

Prepared executables are immutable and stored by dependency, version, and
platform under the Farming configuration directory. A successful preparation
atomically writes a version binding that records the exact executable selected for every
dependency. The running Server has one active binding, while a prepared update
uses a separate non-active binding.

Update preparation downloads and verifies the new release and its dependencies
while the old Server remains available. It does not replace the active binding.
After the package switch, the new launcher revalidates its binding and activates
it before opening the Server port. A rollback starts the old launcher, which
reactivates the old binding.

Farming retains the active binding plus the two newest prepared or rollback
bindings. Cache cleanup removes an executable only after none of those retained
bindings references its exact version and platform. A cleanup failure is
reported but does not turn a healthy Server start into a failed start.

Docker images and browser files used by the optional isolated Browser remain an
explicitly prepared container dependency. They are not stored in, selected
from, or pruned as host executable packages.

`farming runtime prepare` prepares and activates the current release binding.
Deployment and update tooling uses `farming runtime prepare --no-activate`
before the restart window so the running release keeps its current binding.
