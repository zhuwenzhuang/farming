---
name: farming-deploy
description: Build and deploy one committed Farming SHA as a private Linux Release artifact over SSH, including immutable activation, readiness, rollback, and exact-image cleanup. Use when asked to deploy, redeploy, start, update, repair, or validate Farming on a remote Linux server without publishing GitHub or npm artifacts.
---

# Farming Deploy

Use the repository deployment command as the only path that changes the live
installation. Build separately with repository packaging scripts; never install
source dependencies in the live directory or reproduce activation by hand.

## Prepare

1. Work from the Farming repository and read
   `docs/development/remote-deployment-lifecycle.md` plus
   `scripts/deploy.sh --help`.
2. Obtain explicit OpenSSH connection values: host, optional user and port,
   optional `KEY=VALUE` SSH options, and an absolute remote install directory.
   Use normal OpenSSH authentication. Never print credentials or persist a
   private host in the repository.
3. Confirm which Config directory, app port, base path, Server HOME, and ACP
   smoke provider the target owns. Defaults are allowed only when they match the
   requested environment.
4. Pin the requested full git SHA before building. Preserve the target's existing
   Server HOME and Agent Homes unless the user requests a change; a configuration
   change inside a Home is not a request to replace that Home.
5. Read the private builder profile at
   `${CODEX_HOME:-$HOME/.codex}/farming-deploy-builder.json` when present. Validate
   its SSH host, prepared command, immutable image and persistent cache paths
   before use. Keep this machine-specific profile outside the repository.
   Honor its builder and local-Docker policy together with the user's explicit
   choice. Reuse the prepared remote environment; a remote failure never implies
   permission to start local Docker or silently select another builder.

## Choose The Build Path

Prefer the least expensive verified path, in this order:

1. Reuse an existing private app bundle for the exact requested SHA. Check known
   artifact outputs first, run `scripts/verify-release-bundle.ts`, and confirm
   `gitSha`, `linux`/`x64`, `app-bundle`, and the bundled legacy glibc profile.
   Match its checksum sidecar before use. A matching version or filename alone
   is insufficient. For a bundle on the target, use `--remote-artifact` with
   `--git-sha` and `--artifact-sha256`; the canonical verifier runs there. Use
   `--artifact` only for an already-local bundle. These modes are exclusive.
2. When a suitable, authorized Linux x64 builder is available, build there using
   [native Linux preparation](references/native-linux-build.md). Execute on that
   host with its own filesystem and toolchain; do not pass a remote Docker context
   to the Mac's bind-mount-based build script. Reuse the fixed image, pinned tools
   and persistent npm/pnpm/Cargo/Browser/download caches. Run
   `scripts/build-private-linux-native.sh /absolute/output` inside that environment
   with `FARMING_BUILD_CACHE_ROOT` set to its persistent cache root.
3. When builder and target share a host, deploy directly with `--remote-artifact`;
   no archive download, re-upload or self-SSH authentication is needed. For a
   separate builder with existing authorized SSH access, transfer once to the
   target and use the same mode. Do not copy SSH credentials. Client relay is
   reserved for a separate builder without an authorized direct route.

Before expensive packaging, exercise the changed interaction in an isolated
environment, including related transitions and concurrent Sessions. Pin the final
fix commit after these checks; repeat the selected journey after deployment.
Browser cache hits reuse verified bytes across unrelated Farming commits while
retaining compilation provenance. Never edit an old identity sidecar by hand.

Keep successful build outputs available through activation and readiness. A
failure in upload, activation, or smoke does not by itself invalidate the verified
package or justify recompilation. Reuse it after diagnosing and reconciling the
failure unless the evidence identifies an artifact defect.
Report elapsed build, transfer, and activation/readiness time separately when
investigating slow deployment; do not promise a fixed duration without evidence.

## Deploy

Run one activation command for the chosen artifact or build path:

```bash
npm run deploy:remote -- \
  --ssh-host HOST \
  --ssh-user USER \
  --ssh-port PORT \
  --remote-dir /absolute/path/to/farming \
  --remote-artifact /absolute/build/output/farming.tar.gz \
  --git-sha FULL_COMMIT_SHA --artifact-sha256 VERIFIED_SHA256
```

Add only required options such as `--config-dir`, `--server-home`,
`--app-port`, `--base-path`, `--ssh-option`, or `--smoke-agent`.
Always select an artifact explicitly. Use `--artifact /absolute/local/archive`
instead of the three remote-artifact arguments only for an already-local bundle.

The target creates and verifies a unique operation-owned copy; the builder's
original package remains available for recovery or another deployment. This mode
does not invoke local Docker or rsync and uses the existing activation transaction.

The command owns preflight, checksum verification, upload, deployment locking,
runtime preparation, exact Server stop, symlink activation, HTTP/WebSocket/PTY/
ACP smoke, rollback, and bounded image retention. Do not perform any of those
transitions separately while it is running.

## Handle Results

- On success, report the exact git SHA and image ID returned by the command.
  Perform Computer Use acceptance only when the request selects a visible user
  journey; it supplements and never replaces deployment readiness.
- On failure, retain the first failing phase and determine whether the command
  reports that the previous image was restored. Inspect authoritative Server
  state and the current symlink before proposing a fix. Do not rerun until the
  invariant violation is understood.
- Treat a transport timeout as an uncertain deployment outcome. Reconnect and
  read the current image and Config-owned Server state; never blindly replay.
- A confirmed build-only failure leaves the target unchanged. Correct the
  observed prerequisite failure before starting another build; retain verified
  intermediate artifacts when using the separate build path. Do not turn engine
  failures into an automatic retry loop.
- Use `farming-release` instead when the request includes public GitHub Release,
  npm publication, multi-platform artifacts, or an exact release campaign.

## Visible Multi-Agent Acceptance

When visible acceptance is selected, reuse the release Computer Use contract
without turning the private deployment into a public release campaign:

1. Treat the successfully deployed Farming instance as the one system under
   test. Do not start one Farming Server per lane unless the requested contract
   is specifically deployment or Config isolation.
2. Create one real Agent and one Agent-owned Computer Resource per independent
   lane. Give every lane a distinct workspace, Desktop container, browser
   profile, evidence directory, and bounded scenario.
3. Bind every result to the deployed git SHA and image ID. Record the Agent,
   Resource, container image digest, timestamps, action trace, screenshots,
   authoritative backend evidence, and terminal result.
4. Run independent lanes concurrently. Actions inside one lane remain ordered,
   and an uncertain Computer mutation is reconciled by observing before any
   further action.
5. Preserve the first stable failure only for bounded investigation. Delete
   each successful test Agent through Farming so its exact owned Computer is
   removed; verify the recorded Resource and container identities disappeared.

Automated HTTP, WebSocket, PTY, ACP, Playwright, or container checks are not
Computer Use evidence. Historical or unrelated containers are not lane
capacity and must never be reused or broadly cleaned by name pattern.
