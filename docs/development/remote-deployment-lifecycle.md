# Remote Deployment Lifecycle

> Chinese version: [remote-deployment-lifecycle.zh_cn.md](./remote-deployment-lifecycle.zh_cn.md)

This document defines private deployment of one committed Farming version to a
remote Linux Server. It uses the same app-bundle format as release preparation
without creating a GitHub Release or publishing npm.

## Product Contract

The operator supplies ordinary OpenSSH connection parameters and an absolute
remote install path. One repository command builds or accepts one verified
Linux artifact and owns the complete deployment. The target host never receives
source for dependency installation, frontend compilation, or pruning.

The artifact identifies one full git SHA, platform, architecture, compatibility
runtime, package contents, and checksum. Authentication continues through the
target's Config directory; SSH credentials and private host values are not part
of the artifact or repository configuration.

## Ownership And Layout

- The local builder owns artifact construction and verification.
- The operator may select an explicit local Unix-socket Docker context and npm
  registry for the local builder; deployment never infers or changes another
  engine's lifecycle. Remote, TCP, forwarded-socket, and Windows-pipe Docker
  endpoints are rejected before remote preflight or source-worktree creation
  because the builder bind-mounts repository paths from the local host.
- The local builder caches checksum-pinned compatibility runtime inputs outside
  the artifact output; every reuse is revalidated before packaging.
- The canonical Config directory owns Server, authentication, Agent, PTY, ACP,
  Browser, and Computer state.
- The deployment root beside the configured install path owns immutable images,
  staging, the deployment lock, and the rollback selection.
- The configured install path is one symlink selecting the image used by future
  launches. A live Server remains bound to the resolved image that started it.

Config state and deployment images never share an ownership identity. Updating
one install path may stop only the exact Server proven by the selected Config.

## State Machine

| State | Trigger and effect | Terminal failure or recovery |
| --- | --- | --- |
| Idle | No deployment owns the target lock. | A new operation may start. |
| Building | An isolated Linux builder packages one committed SHA. | Build failure leaves the remote target unchanged. |
| Staging | The checksum-matched archive is safely extracted to a unique staging path. | Invalid paths, metadata, platform, or identity remove only that staging path. |
| Prepared | Native modules load through the artifact compatibility runtime and fixed runtimes are prepared with `--no-activate`. | Failure leaves the current Server live. |
| Activating | The exact old Server stops, its Config is checkpointed, a working copy is created on the same filesystem, a symlink atomically selects the prepared image, and the new Server starts against the working copy. | A stop or checkpoint failure leaves selection and durable Config state unchanged. A selection or start failure enters rollback. |
| Verifying | Authenticated HTTP, versioned WebSocket, PTY Host, ACP Host, and one fresh empty Chat are exercised through internal smoke Agents that stay out of interactive browser inventories, then those exact Agents are removed. | Any failure enters rollback without replaying an uncertain mutation. |
| Succeeded | Current and rollback selections are recorded and only safe old images outside retention are removed. | Cleanup failure does not invalidate the running image and remains visible. |
| Rolling back | The failed image stops, its working Config copy is isolated, the pre-activation Config checkpoint is restored, the prior image is selected, and its Server starts. | Success ends as a visible failed deployment with the prior image and its compatible Config state restored; rollback failure retains exact snapshots and requires operator action. |

Only one activation owns a deployment root. Another activation fails immediately
while the lock owner is live. Preparation is idempotent by artifact checksum;
activation is not replayed after an ambiguous transport outcome. The operator
must first reconcile the current symlink and Config-owned Server state.

## Safety And Liveness

Safety requires:

1. only a checksum-verified, self-contained Linux artifact may become an image;
2. image contents are complete before publication and are never modified in
   place afterward;
3. no Server stop occurs before native dependency and runtime preflight passes;
4. current selection changes atomically and exact prior selection remains
   available through verification;
5. a new image may migrate only its working Config copy until readiness succeeds;
   rollback restores the exact pre-activation Config rather than asking an older
   image to read state written by a newer schema;
6. smoke Agents remain internal to readiness, while stop, smoke cleanup,
   rollback, and retention target exact Config, Agent, and image identities;
7. private SSH or Farming credentials are neither printed nor copied into an
   image.

Under normal filesystem, SSH, container-builder, provider, and process-control
availability, every operation reaches success, a restored prior image, or a
visible operator-required failure. Timeouts are bounded at their owning product
protocol rather than hidden behind deployment retries.

## Verification

Automated verification covers invalid artifacts, rejection of non-local Docker
contexts before build or SSH work, native-module preflight, concurrent
activation, startup failure, product-smoke failure, exact rollback, first
migration from a legacy source directory, and bounded cleanup. A real target
acceptance additionally builds the private Linux artifact, deploys it through
the public command surface, confirms the exact selected SHA, and uses a real
provider plus visible UI journeys selected by the changed behavior.
