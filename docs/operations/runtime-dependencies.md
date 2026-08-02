# Runtime dependency versions

> Chinese version: [runtime-dependencies.zh_cn.md](./runtime-dependencies.zh_cn.md)

Farming keeps platform executables such as Codex, Claude Code, and
`agent-browser` outside the application package. Each Farming release pins exact
versions, download integrity, executable entries, and supported platform keys.

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
