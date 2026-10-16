# Native Linux Artifact Preparation

Use this path when an authorized Linux x64 build environment is available and
avoids a cold or emulated local Docker build. Build location and live activation
are independent: `deploy.sh` still owns all live transitions.

## Preflight And Ownership

- Confirm the builder's architecture, available disk, Node/npm compatibility,
  and pinned Rust, Zig, cargo-zigbuild and pnpm versions. Read the current pins
  in `backend/data/agent-browser-source.json` and npm version in
  `scripts/build-private-linux-release.sh`; do not copy historical versions.
- Use a clean, exact-SHA checkout in a dedicated build root. Transfer committed
  Git objects if the builder cannot fetch the repository. Keep credentials,
  untracked work, live installation, and Config directories out of the source
  transfer. Do not switch the primary development checkout to perform a build.
- The builder may share a physical host with the target only when its build root,
  processes, and resource use are isolated from the running instance. Prefer an
  existing prepared builder; a cold machine is not automatically faster.
- Keep the source, Browser output, package output, and logs in separately owned
  paths. Reuse npm and checksum-verified runtime download caches. Remove only
  temporary files and processes created by this build; retain verified outputs
  until deployment finishes.
- Keep the prepared image, pinned tool installation and persistent cache root
  across commits. Record their machine-specific paths in the private builder
  profile referenced by the skill. Unavailable tools are an explicit preflight
  failure, never a local Docker fallback.

## Build With The Repository Scripts

Run from the clean checkout, with the selected compatible Node/npm on PATH.
The prepared environment can execute the complete private build with:

```bash
FARMING_BUILD_CACHE_ROOT=/absolute/persistent/cache \
  scripts/build-private-linux-native.sh /absolute/artifact/output
```

It revalidates an existing exact-SHA archive before reuse; otherwise it installs
source dependencies from persistent caches, assembles the Browser component and
runs the repository packager. The following steps describe the underlying
repository interfaces for explicit build orchestration.

Set `FARMING_SKIP_INSTALL_RUNTIME_PREPARE=1`,
`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`, and `PUPPETEER_SKIP_DOWNLOAD=1` for dependency
installation. Run `timeout 300 npm ci --prefer-offline --no-audit --no-fund`.
Do not copy Mac `node_modules` into a Linux package.

Build the patched Browser runtime with:

```bash
node scripts/build-agent-browser-runtime.mjs \
  --platform linux-x64-musl --output "$BUILD_BROWSER_OUTPUT"
```

`BUILD_BROWSER_OUTPUT` must be an absolute, build-owned artifact root. Set
`FARMING_AGENT_BROWSER_BUILD_CACHE` to the persistent Browser build cache when
calling the component builder directly. Its key covers the source pin and patch,
both build-recipe files, pinned toolchains, compiler overrides, host and target.
A hit verifies the receipt, regular files and full checksums before emitting a
candidate-SHA assembly that preserves `compilationOrigin`. A corrupt entry fails
explicitly and remains inspectable. Failed private staging is removed; concurrent
publishers verify the atomically published winner. Packaging still requires the
candidate's exact `farmingSha`; never rewrite identity metadata by hand.

Package with `npm run release:app:legacy-linux`, setting:

- `FARMING_RELEASE_GIT_SHA` to the verified checkout HEAD;
- `FARMING_RELEASE_UPDATE_METHOD=app-bundle` (the legacy packager otherwise
  defaults to a different update method);
- `FARMING_RELEASE_DIR` and `FARMING_RELEASE_NAME` to exact build-owned output
  paths and a name containing the version and short SHA;
- `FARMING_AGENT_BROWSER_ARTIFACTS` to `BUILD_BROWSER_OUTPUT`;
- `FARMING_GLIBC_RUNTIME_CACHE` and `FARMING_RIPGREP_ARCHIVE_CACHE` to verified
  caches when available.

Run `node --import tsx scripts/verify-release-bundle.ts "$BUILD_ARCHIVE"` and
verify its checksum sidecar. Inspect the release metadata for the full SHA,
Linux x64, `app-bundle`, `linux-x64-legacy-glibc228`, and bundled glibc. When the
archive is already on the target, invoke the ordinary deployment command with
`--remote-artifact /absolute/archive --git-sha FULL_SHA --artifact-sha256 DIGEST`.
It sends only the verifier and activation code over the existing client SSH
connection, preserving the original archive. Separate builders should transfer
once to the target when already authorized. Client relay is needed only without
an authorized direct route; do not copy SSH credentials. Every route uses the
same target activation protocol.

A build failure leaves live state untouched. Preserve the first failure, fix
its cause, and resume at the failed build stage using still-valid outputs. Once
activation starts, reconcile uncertain outcomes from the target before another
activation; a successful build alone is not deployment success.
