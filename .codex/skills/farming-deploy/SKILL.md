---
name: farming-deploy
description: Build and deploy one committed Farming SHA as a private Linux Release artifact over SSH, including immutable activation, readiness, rollback, and exact-image cleanup. Use when asked to deploy, redeploy, start, update, repair, or validate Farming on a remote Linux server without publishing GitHub or npm artifacts.
---

# Farming Deploy

Use the repository deployment command as the only state-changing path. Do not
sync source, run npm installation in the live directory, reproduce activation
steps by hand, or compensate for a failure with retries.

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

## Deploy

Run exactly one command:

```bash
npm run deploy:remote -- \
  --ssh-host HOST \
  --ssh-user USER \
  --ssh-port PORT \
  --remote-dir /absolute/path/to/farming
```

Add only required options such as `--config-dir`, `--server-home`,
`--app-port`, `--base-path`, `--ssh-option`, `--docker-context`,
`--npm-registry`, or `--smoke-agent`. Use
`--artifact` only for an already verified private app bundle; otherwise let the
command build the committed SHA in its Linux builder.

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
- Use `farming-release` instead when the request includes public GitHub Release,
  npm publication, multi-platform artifacts, or an exact release campaign.
