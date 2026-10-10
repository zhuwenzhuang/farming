const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const YAML = require('yaml');

function run() {
  const preparationWorkflowSource = fs.readFileSync(
    path.join(process.cwd(), '.github/workflows/release.yml'),
    'utf8',
  );
  const publicationWorkflowSource = fs.readFileSync(
    path.join(process.cwd(), '.github/workflows/publish-release.yml'),
    'utf8',
  );
  const releaseWorkflowSource = `${preparationWorkflowSource}\n${publicationWorkflowSource}`;
  assert(releaseWorkflowSource.includes('node --import tsx scripts/verify-release-bundle.ts'));
  assert(publicationWorkflowSource.includes('release-metadata-${file.slice'));
  assert(publicationWorkflowSource.includes('bundledGlibcRuntime'));
  assert(publicationWorkflowSource.includes("(-legacy-glibc228)?\\.tar\\.gz"));
  assert(publicationWorkflowSource.includes('compatibilityProfile: bundle.compatibilityProfile'));
  assert(preparationWorkflowSource.includes('runner: macos-15-intel'));
  assert(preparationWorkflowSource.includes('runner: macos-15'));
  assert(preparationWorkflowSource.includes('Verify native runner architecture'));
  assert(preparationWorkflowSource.includes('farming-${FARMING_RELEASE_VERSION}-darwin-${{ matrix.arch }}.tar.gz'));
  assert(preparationWorkflowSource.includes('Smoke-test macOS app bundle'));
  assert(publicationWorkflowSource.includes('body.replaceAll(`](./v${version}.zh_cn.md)`, `](./release-notes/v${version}.zh_cn.md)`)'));
  assert(publicationWorkflowSource.includes('body.replaceAll(`](./v${version}.md)`, `](./release-notes/v${version}.md)`)'));
  assert(releaseWorkflowSource.includes('node scripts/verify-release-notes.mjs "${RELEASE_VERSION}"'));
  assert(preparationWorkflowSource.includes('npm run release:dependencies:check'));
  assert(publicationWorkflowSource.includes('RELEASE_CODENAME: ${{ steps.notes.outputs.codename }}'));
  assert(publicationWorkflowSource.includes('release_title="Farming ${RELEASE_VERSION}"'));
  assert(publicationWorkflowSource.includes('release_title+=" · ${RELEASE_CODENAME}"'));
  assert(publicationWorkflowSource.includes('--title "${release_title}"'));
  assert(preparationWorkflowSource.includes('workflow_dispatch:'));
  assert(publicationWorkflowSource.includes('workflow_dispatch:'));
  assert(!releaseWorkflowSource.includes("push:\n    tags:\n      - 'v*'"));

  const npmPrepareJob = preparationWorkflowSource.slice(
    preparationWorkflowSource.indexOf('  prepare-npm:'),
  );
  const publicationJob = publicationWorkflowSource.slice(
    publicationWorkflowSource.indexOf('  publish-release:'),
  );
  assert(npmPrepareJob.includes('npm run release:npm:pack -- "${package_dir}"'));
  assert(npmPrepareJob.includes('npm run release:npm:smoke -- "${package_tarball}"'));
  assert(!preparationWorkflowSource.includes('Create or refresh draft release'));
  assert(!preparationWorkflowSource.includes('npm publish'));
  assert(!preparationWorkflowSource.includes('acceptance_context'));
  assert(publicationJob.includes('Require successful candidate push workflows'));
  assert(publicationJob.includes('--draft'));
  assert(publicationJob.includes('git push origin "refs/tags/${RELEASE_TAG}"'));
  assert(publicationJob.includes('gh release edit "${tag}" --repo "${GITHUB_REPOSITORY}" --draft=false'));
  assert(publicationJob.includes('https://api.github.com/repos/${GITHUB_REPOSITORY}/releases/tags/${tag}'));
  assert(publicationJob.includes('GitHub Release is missing assets'));
  assert(publicationJob.includes('node scripts/verify-public-release-assets.mjs'));
  assert(publicationJob.includes('supplementalPublicFiles'));
  assert(publicationJob.includes('npm install --global npm@latest'));
  assert(publicationJob.includes('npm-release-evidence.mjs verify'));
  assert(!publicationJob.includes('sha256sum --check'));
  assert(!npmPrepareJob.includes('sha256sum "${package_tarball}"'));
  assert(publicationJob.includes('npm publish "./${package_tarball}"'));
  assert(publicationJob.includes('NPM_UPLOAD_MAY_HAVE_STARTED=${recoverableNpmPublicationFailure'));
  assert(publicationJob.includes('run-id: ${{ inputs.preparation_run_id }}'));
  assert(publicationJob.includes('github-token: ${{ github.token }}'));
  assert(publicationJob.includes("workflow.path !== '.github/workflows/release.yml'"));
  assert(publicationJob.includes('run.head_sha !== process.env.CANDIDATE_SHA'));
  assert(publicationJob.includes('scripts/watch-candidate-workflows.sh "${GITHUB_SHA}" "${GITHUB_REPOSITORY}" 0 once'));
  assert(!publicationJob.includes('for attempt in {1..120}'));
  assert(!publicationJob.includes('sleep 5'));

  const candidateWorkflowGateOffset = publicationJob.indexOf('\n      - name: Require successful candidate push workflows');
  const acceptanceGateOffset = publicationJob.indexOf('\n      - name: Require successful automated and Computer Use acceptance');
  const draftOffset = publicationJob.indexOf('\n      - name: Create or refresh draft release');
  const githubPublishOffset = publicationJob.indexOf('\n      - name: Publish the matching draft release');
  const githubVerifyOffset = publicationJob.indexOf('\n      - name: Verify public tag, assets, and manifest');
  const npmPublishOffset = publicationJob.indexOf('\n      - name: Verify and publish npm package with provenance');
  assert(
    candidateWorkflowGateOffset >= 0
      && candidateWorkflowGateOffset < acceptanceGateOffset
      && acceptanceGateOffset < draftOffset
      && draftOffset < githubPublishOffset
      && githubPublishOffset < githubVerifyOffset
      && githubVerifyOffset < npmPublishOffset,
    'publication must keep exact-SHA preparation, candidate workflows, acceptance, GitHub publication, public verification, and npm publication in safe order',
  );
  assert(!releaseWorkflowSource.includes('run: npm run check'));

  const preparationWorkflow = YAML.parse(preparationWorkflowSource);
  const publicationWorkflow = YAML.parse(publicationWorkflowSource);
  assert.deepStrictEqual(publicationWorkflow.concurrency, {
    group: 'farming-publication-${{ inputs.release_version }}', 'cancel-in-progress': false,
  }, 'one workflow must own a version upload and its publication status at a time');
  const npmStep = publicationWorkflow.jobs['publish-release'].steps.find(
    step => step.name === 'Verify and publish npm package with provenance',
  );
  assert(npmStep.run.indexOf('npm-release-evidence.mjs verify') < npmStep.run.indexOf('npm publish'));
  assert(npmStep.run.indexOf('NPM_UPLOAD_MAY_HAVE_STARTED:-0') < npmStep.run.indexOf('npm publish'));
  assert(npmStep.run.indexOf('-f npm-evidence/upload-intent.json') < npmStep.run.indexOf('npm publish'),
    'a retained main upload intent must prevent replay even after a later carrier-only recovery failure');
  assert(npmStep.run.includes('|| upload_exit=$?'), 'uncertain upload failures must reconcile without replay');
  const npmObservation = publicationWorkflow.jobs['publish-release'].steps.find(
    step => step.name === 'Wait for npm package to become public',
  );
  assert(npmObservation.run.includes("!= '3'"),
    'normal awaiting-public observation must not fail the upload workflow');
  assert(npmObservation.run.includes('npm-release-evidence.mjs report'));
  const npmStatus = publicationWorkflow.jobs['publish-release'].steps.find(
    step => step.name === 'Record npm publication status',
  );
  assert.strictEqual(npmStatus.if, "always() && steps.npm-publication.outputs.commit_state != ''");
  assert(npmStatus.run.includes('farming/npm-publication/${FARMING_RELEASE_VERSION}'),
    'workflow completion and authoritative npm publication must have separate status');
  assert.strictEqual(publicationWorkflow.jobs['publish-release'].steps.find(
    step => step.name === 'Upload npm publication evidence',
  )?.if, 'always()');
  assert.deepStrictEqual(preparationWorkflow.permissions, { contents: 'read', actions: 'read' });
  assert.deepStrictEqual(
    publicationWorkflow.permissions,
    { actions: 'read', contents: 'read', statuses: 'read' },
  );
  for (const input of ['release_version', 'candidate_sha', 'preparation_run_id', 'acceptance_context']) {
    assert.strictEqual(publicationWorkflow.on.workflow_dispatch.inputs[input].required, true);
  }
  assert.strictEqual(publicationWorkflow.on.workflow_dispatch.inputs.failed_publication_run_id.required, false);
  assert.strictEqual(publicationWorkflow.on.workflow_dispatch.inputs.failed_publication_run_id.default, '');
  assert.strictEqual(preparationWorkflow.on.workflow_dispatch.inputs.acceptance_context, undefined);
  assert.deepStrictEqual(
    preparationWorkflow.jobs['build-linux'].strategy.matrix.kind,
    ['cli', 'app', 'legacy'],
  );
  assert.deepStrictEqual(
    [...preparationWorkflow.jobs['build-macos'].strategy.matrix.include,
      ...preparationWorkflow.jobs['build-macos-cli'].strategy.matrix.include]
      .map(entry => `${entry.arch}:${entry.kind}`),
    ['x64:app', 'arm64:app', 'x64:cli', 'arm64:cli'],
  );
  for (const jobName of ['build-linux', 'build-macos', 'build-macos-cli', 'prepare-npm']) {
    const job = preparationWorkflow.jobs[jobName];
    const archiveCache = job.steps.find(step => step.name === 'Cache pinned ripgrep archives');
    assert.strictEqual(job.env.FARMING_RIPGREP_ARCHIVE_CACHE, undefined,
      'runner context is unavailable in job-level env');
    const cacheRoot = job.steps.find(step => step.name === 'Set pinned download cache root');
    assert.strictEqual(cacheRoot?.run,
      'echo "FARMING_RIPGREP_ARCHIVE_CACHE=${RUNNER_TEMP}/farming-ripgrep-archives" >> "${GITHUB_ENV}"');
    assert.strictEqual(archiveCache?.uses, 'actions/cache@v4');
    assert.strictEqual(archiveCache?.with.path, '${{ runner.temp }}/farming-ripgrep-archives');
    assert.strictEqual(archiveCache?.with.key,
      `managed-ripgrep-v1-\${{ runner.os }}-\${{ runner.arch }}-${jobName}-\${{ hashFiles('backend/ripgrep-runtime.cts') }}`);
    assert.strictEqual(archiveCache.with['restore-keys'], undefined,
      'an upgraded inventory must not restore the old download set');
    assert(job.steps.indexOf(cacheRoot) < job.steps.indexOf(archiveCache));
    assert(job.steps.indexOf(archiveCache) < job.steps.findIndex(step => step.name === 'Install dependencies'),
      'archive retention must survive the clean source install');
  }
  const agentBrowserJob = preparationWorkflow.jobs['build-agent-browser'];
  assert(agentBrowserJob, 'release preparation must build the patched agent-browser runtimes');
  assert.strictEqual(agentBrowserJob.needs, 'preflight');
  assert.deepStrictEqual(
    agentBrowserJob.strategy.matrix.include.map(entry => entry.platform),
    [
      'linux-arm64',
      'linux-x64',
      'linux-arm64-musl',
      'linux-x64-musl',
      'win32-x64',
    ],
  );
  assert.deepStrictEqual(
    agentBrowserJob.strategy.matrix.include.map(entry => entry.runner),
    ['ubuntu-24.04-arm', 'ubuntu-24.04', 'ubuntu-24.04-arm', 'ubuntu-24.04', 'windows-latest'],
  );
  const lineEndingSetupIndex = agentBrowserJob.steps.findIndex(
    step => step.name === 'Preserve pinned source line endings',
  );
  const agentBrowserCheckoutIndex = agentBrowserJob.steps.findIndex(step => step.name === 'Checkout');
  assert(lineEndingSetupIndex >= 0 && lineEndingSetupIndex < agentBrowserCheckoutIndex);
  assert.strictEqual(
    agentBrowserJob.steps[lineEndingSetupIndex].run,
    'git config --global core.autocrlf false',
  );
  assert.strictEqual(
    agentBrowserJob.steps.find(step => step.name === 'Setup Node.js')?.with['node-version'],
    '24',
  );
  const rustSetup = agentBrowserJob.steps.find(step => step.name === 'Setup Rust');
  assert.strictEqual(rustSetup?.with.toolchain, '1.96.1');
  assert.strictEqual(rustSetup?.with.target, '${{ matrix.rustTarget }}');
  assert.strictEqual(
    rustSetup?.with.rustflags,
    '',
    'the pinned upstream runtime must not inherit setup-rust-toolchain -D warnings',
  );
  const zigSetup = agentBrowserJob.steps.find(step => step.name === 'Install pinned Zig cross-build tools');
  assert.strictEqual(zigSetup?.if, "matrix.zig && needs.preflight.outputs.browser_origin_run_id == ''");
  assert(zigSetup?.run.includes('ziglang==0.15.2'));
  assert(zigSetup?.run.includes('cargo-zigbuild --version 0.22.3 --locked'));
  assert.strictEqual(
    agentBrowserJob.steps.find(step => step.name === 'Build and verify patched agent-browser')?.run,
    'node scripts/build-agent-browser-runtime.mjs --platform "${{ matrix.platform }}" --output "$RUNNER_TEMP/agent-browser-artifacts"',
  );
  const nativeUpload = agentBrowserJob.steps.find(step => step.name === 'Upload patched agent-browser runtime');
  const cargoCache = agentBrowserJob.steps.find(step => step.name === 'Cache patched browser Cargo intermediates');
  assert.strictEqual(cargoCache?.with.path, '${{ runner.temp }}/farming-agent-browser-cargo-target');
  for (const input of ['runner.os', 'runner.arch', 'matrix.platform', 'rust-1.96.1', 'backend/data/agent-browser-source.json', 'patches/agent-browser/*.patch', 'scripts/build-agent-browser-runtime.mjs']) {
    assert(cargoCache?.with.key.includes(input), `Cargo cache must isolate ${input}`);
  }
  assert.strictEqual(cargoCache.with['restore-keys'], 'agent-browser-cargo-v2-${{ runner.os }}-${{ runner.arch }}-rust-1.96.1-${{ matrix.platform }}-source-');
  for (const entry of agentBrowserJob.strategy.matrix.include) {
    const restore = cargoCache.with['restore-keys'].replace('${{ matrix.platform }}', entry.platform);
    for (const other of agentBrowserJob.strategy.matrix.include) {
      const key = cargoCache.with.key.replace('${{ matrix.platform }}', other.platform);
      assert.strictEqual(key.startsWith(restore), entry.platform === other.platform,
        `Cargo restore must distinguish ${entry.platform} from ${other.platform}, including GNU and musl`);
    }
  }
  assert.strictEqual(agentBrowserJob.steps.find(step => step.name === 'Build and verify patched agent-browser')?.env.CARGO_TARGET_DIR, cargoCache.with.path);
  const npmPrep = preparationWorkflow.jobs['prepare-npm'].steps;
  assert(npmPrep.some(step => step.name === 'Upload npm smoke receipt'
    && step.with.path === 'npm-upload/npm-smoke-receipt.json'));
  assert(npmPrep.find(step => step.name === 'Build and smoke one npm tarball')?.run.includes('npm-release-evidence.mjs write'));
  assert.strictEqual(nativeUpload?.with.name, 'farming-agent-browser-${{ matrix.platform }}');
  assert.strictEqual(nativeUpload?.with.path, '${{ runner.temp }}/agent-browser-artifacts');
  assert(
    preparationWorkflow.jobs['build-linux'].steps.some(
      step => step.name === 'Smoke-test Linux app bundle'
        && step.run.includes('farming-release-stage-app'),
    ),
    'Linux app smoke must consume the retained exact assembly directory',
  );
  assert.strictEqual(preparationWorkflow.jobs['stage-release'], undefined);
  assert.strictEqual(publicationWorkflow.jobs['build-linux'], undefined);
  assert.strictEqual(publicationWorkflow.jobs['build-macos'], undefined);
  assert.strictEqual(publicationWorkflow.jobs['prepare-npm'], undefined);
  assert(
    !publicationWorkflow.jobs['publish-release'].steps.some(step => step.name === 'Install dependencies'),
    'publication must reuse verified artifacts without installing the repository dependency tree',
  );
  const candidateWorkflowGate = publicationWorkflow.jobs['publish-release'].steps.find(
    step => step.name === 'Require successful candidate push workflows',
  );
  assert(candidateWorkflowGate, 'release publication must require every workflow from the exact candidate push');
  assert.strictEqual(candidateWorkflowGate.env.GH_TOKEN, '${{ github.token }}');
  for (const jobName of ['build-linux', 'build-macos-cli', 'prepare-npm']) {
    const job = preparationWorkflow.jobs[jobName];
    assert.deepStrictEqual(job.needs, ['preflight', 'build-agent-browser', 'build-macos-browser']);
    assert.strictEqual(job.env.FARMING_AGENT_BROWSER_ARTIFACTS, '${{ github.workspace }}/../release-agent-browser-artifacts');
    const installScripts = job.steps.map(step => step.run ?? '').join('\n');
    assert(
      installScripts.indexOf('npm install --global npm@12.0.2') >= 0
        && installScripts.indexOf('npm install --global npm@12.0.2') < installScripts.indexOf('npm ci'),
      `${jobName} must select the pinned npm 12 resolver before npm ci`,
    );
    const download = job.steps.find(step => step.name === 'Download patched agent-browser runtimes');
    assert(download, `${jobName} must consume the verified patched agent-browser matrix`);
    assert.strictEqual(download.with.pattern, 'farming-agent-browser-*');
    assert.strictEqual(download.with.path, '${{ github.workspace }}/../release-agent-browser-artifacts');
    assert.strictEqual(download.with['merge-multiple'], true);
  }
  const macJob = preparationWorkflow.jobs['build-macos'];
  const nativeProducer = preparationWorkflow.jobs['build-macos-browser'];
  assert.strictEqual(nativeProducer.needs, 'preflight');
  assert.deepStrictEqual(macJob.needs, ['preflight', 'build-macos-browser']);
  assert(!macJob.steps.some(step => step.run?.includes('build-agent-browser-runtime.mjs')),
    'App assembly must not compile a second native Browser');
  const transfer = macJob.steps.find(step => step.name === 'Restore and verify transferred native Browser');
  assert(transfer?.run.includes('scripts/transfer-native-browser-runtime.mjs'));
  assert(macJob.steps.some(step => step.name === 'Download native candidate Browser'
    && step.with.name === 'farming-agent-browser-darwin-${{ matrix.arch }}'));
  for (const job of [agentBrowserJob, nativeProducer]) {
    const assembly = job.steps.find(step => step.name.includes('component for candidate'));
    assert(assembly, 'an unchanged component must be assembled for the current candidate');
    assert.strictEqual(assembly.if, "needs.preflight.outputs.browser_origin_run_id != ''");
    assert(assembly.run.includes('scripts/reuse-agent-browser-runtime.mjs emit'));
    const originDownload = job.steps.find(step => step.name.includes('Download unchanged'));
    assert.strictEqual(originDownload?.with['run-id'], '${{ needs.preflight.outputs.browser_origin_run_id }}');
  }
  const macNativeUpload = nativeProducer.steps.find(step => step.name === 'Upload verified native macOS browser runtime');
  assert.strictEqual(macNativeUpload?.with.name, 'farming-agent-browser-darwin-${{ matrix.arch }}');
  assert.strictEqual(macNativeUpload?.with.path, '${{ runner.temp }}/signed-agent-browser-artifacts');
  assert.strictEqual(macNativeUpload?.with['if-no-files-found'], 'error');
  assert(nativeProducer.steps.findIndex(step => step.name === 'Sign and verify native candidate Browser')
    < nativeProducer.steps.indexOf(macNativeUpload));
  for (const name of ['Smoke-test patched browser runtime on macOS', 'Verify macOS app bundle', 'Smoke-test macOS app bundle']) {
    assert(macJob.steps.some(step => step.name === name && step.if === "matrix.kind == 'app'"),
      'complete native acceptance remains required before preparation can succeed');
  }
  const runtimePlatforms = [
    ...agentBrowserJob.strategy.matrix.include.map(entry => entry.platform),
    ...nativeProducer.strategy.matrix.include.map(entry => `darwin-${entry.arch}`),
  ];
  assert.deepStrictEqual([...runtimePlatforms].sort(),
    ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-arm64-musl', 'linux-x64', 'linux-x64-musl', 'win32-x64']);
  assert.strictEqual(new Set(runtimePlatforms).size, runtimePlatforms.length, 'each runtime platform has one producer');
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (name: string): void => {
    assert(preparationWorkflow.jobs[name], `unknown workflow dependency: ${name}`);
    assert(!visiting.has(name), `release preparation dependency cycle at ${name}`);
    if (visited.has(name)) return;
    visiting.add(name);
    const dependencies = preparationWorkflow.jobs[name].needs;
    for (const dependency of Array.isArray(dependencies) ? dependencies : dependencies ? [dependencies] : []) visit(dependency);
    visiting.delete(name);
    visited.add(name);
  };
  for (const name of Object.keys(preparationWorkflow.jobs)) visit(name);
  const linuxJob = preparationWorkflow.jobs['build-linux'];
  const linuxChrome = linuxJob.steps.find(step => step.name === 'Setup Chrome for patched runtime smoke');
  assert.strictEqual(linuxChrome?.if, "matrix.kind == 'app'");
  assert.strictEqual(linuxChrome?.uses, 'browser-actions/setup-chrome@v2');
  assert.strictEqual(linuxChrome?.with['chrome-version'], 'stable');
  const linuxBrowserSmoke = linuxJob.steps.find(
    step => step.name === 'Smoke-test patched browser runtime on Linux',
  );
  assert.strictEqual(linuxBrowserSmoke?.if, "matrix.kind == 'app'");
  assert(linuxBrowserSmoke?.run.includes('npx tsx scripts/smoke-browser-idle.ts'));
  assert(linuxBrowserSmoke?.run.includes('${{ steps.setup-chrome.outputs.chrome-path }}'));
  assert(
    preparationWorkflow.jobs['build-linux'].steps
      .find(step => step.name === 'Smoke-test patched browser runtime on Linux')
      ?.run.includes('$PWD/dist/runtime/agent-browser/linux-x64/agent-browser'),
  );
  const linuxArm64Smoke = preparationWorkflow.jobs['build-linux'].steps
    .find(step => step.name === 'Smoke-test Linux arm64 CLI server and native PTY');
  assert(
    linuxArm64Smoke?.run.includes('-e FARMING_SKIP_RUNTIME_PREPARE=1')
      && linuxArm64Smoke.run.includes('-e FARMING_SMOKE_AGENT=0'),
    'the emulated arm64 CLI smoke must validate startup without downloading unrelated Agent runtimes',
  );
  const macosJob = preparationWorkflow.jobs['build-macos'];
  const macosChrome = macosJob.steps
    .find(step => step.name === 'Verify system Chrome for patched runtime smoke');
  assert.strictEqual(macosChrome?.if, "matrix.kind == 'app'");
  assert(
    macosChrome?.run.includes('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
      && macosChrome.run.includes('--version'),
    'macOS app smoke must exercise the system Chrome used by the released product',
  );
  const macosRuntimeRust = nativeProducer.steps
    .find(step => step.name === 'Setup Rust for native macOS browser runtime');
  assert.strictEqual(macosRuntimeRust?.if, "needs.preflight.outputs.browser_origin_run_id == ''");
  assert.strictEqual(macosRuntimeRust?.with.toolchain, '1.96.1');
  assert.strictEqual(
    macosRuntimeRust?.with.target,
    "${{ matrix.arch == 'arm64' && 'aarch64-apple-darwin' || 'x86_64-apple-darwin' }}",
  );
  const macosRuntimeBuild = nativeProducer.steps
    .find(step => step.name === 'Build native macOS browser runtime');
  const macosCargoCache = nativeProducer.steps.find(step => step.name === 'Cache patched browser Cargo intermediates');
  assert.deepStrictEqual(macosCargoCache?.with['restore-keys'].trim().split('\n'), [
    'agent-browser-cargo-v2-${{ runner.os }}-${{ runner.arch }}-rust-1.96.1-darwin-${{ matrix.arch }}-source-',
    'agent-browser-cargo-v1-${{ runner.os }}-${{ runner.arch }}-rust-1.96.1-darwin-${{ matrix.arch }}-',
  ]);
  assert.strictEqual(macosRuntimeBuild?.if, "needs.preflight.outputs.browser_origin_run_id == ''");
  assert(
    macosRuntimeBuild?.run.includes('--platform "darwin-${{ matrix.arch }}"')
      && macosRuntimeBuild.run.includes('FARMING_AGENT_BROWSER_ARTIFACTS=${native_artifacts}')
      && macosRuntimeBuild.run.includes('${GITHUB_ENV}'),
    'native Browser construction must select one production runtime before parallel packaging',
  );
  assert(
    macosJob.steps
      .find(step => step.name === 'Smoke-test patched browser runtime on macOS')
      ?.run.includes('$PWD/dist/runtime/agent-browser/darwin-${{ matrix.arch }}/agent-browser')
      && macosJob.steps
        .find(step => step.name === 'Smoke-test patched browser runtime on macOS')
        ?.run.includes('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
  );
  const dependencyUpdateGate = preparationWorkflow.jobs.preflight.steps.find(
    step => step.name === 'Check managed Agent dependency updates',
  );
  assert.strictEqual(
    dependencyUpdateGate?.run,
    'npm run release:dependencies:check',
    'release preflight must fail closed before artifact jobs when managed Agent pins are not current',
  );
  assert.deepStrictEqual(
    publicationWorkflow.jobs['publish-release'].permissions,
    { actions: 'read', contents: 'write', 'id-token': 'write', statuses: 'write' },
  );
  assert(publicationWorkflowSource.includes("if: inputs.failed_publication_run_id == ''"));
  assert(publicationWorkflowSource.includes("if: inputs.failed_publication_run_id != ''"));
  assert(publicationWorkflowSource.includes("workflow.path !== '.github/workflows/publish-release.yml'"));
  assert(
    publicationWorkflowSource.includes("publicVerification?.conclusion === 'failure'")
      && publicationWorkflowSource.includes("npmPublication?.conclusion === 'skipped'")
      && publicationWorkflowSource.includes("publicVerification?.conclusion === 'success'")
      && publicationWorkflowSource.includes("npmPublication?.conclusion === 'failure'"),
    'publication recovery must accept failure at either public-asset verification or npm publication',
  );
  const publicationSteps = publicationWorkflow.jobs['publish-release'].steps;
  const publicationStepIndex = (name: string) => publicationSteps.findIndex(step => step.name === name);
  const publicationStep = (name: string) => publicationSteps.find(step => step.name === name);
  assert(publicationStepIndex('Verify and publish npm runtime packages with provenance')
    < publicationStepIndex('Verify and publish npm package with provenance'),
  'carrier publication must finish before the main upload step can start');
  assert.strictEqual(publicationStep('Download prior npm publication evidence').if,
    "inputs.failed_publication_run_id != '' && env.NPM_PUBLICATION_EVIDENCE_REQUIRED == '1'");
  const runtimePublicationScript = publicationStep('Verify and publish npm runtime packages with provenance').run;
  assert(runtimePublicationScript.indexOf('cp prior-npm-evidence/*.json npm-evidence/')
    < runtimePublicationScript.indexOf('node scripts/publish-npm-runtimes.mjs'),
  'preserve all prior intents before any carrier reconciliation can fail');
  const recoveryScript = publicationStep('Verify exact preparation run').run.match(
    /RUN_JSON="\$\{publication_run\}"[^\n]*node <<'NODE'\n([\s\S]*?)\nNODE/,
  )?.[1];
  assert(recoveryScript, 'recover the actual workflow classification script');
  const recoveryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-publication-recovery-'));
  try {
    const fakeNpm = path.join(recoveryRoot, 'npm');
    fs.writeFileSync(fakeNpm, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    fs.mkdirSync(path.join(recoveryRoot, 'npm-evidence'));
    const guard = npmStep.run.slice(npmStep.run.indexOf('if [[ "${NPM_UPLOAD_MAY_HAVE_STARTED'),
      npmStep.run.indexOf('dist_tag="latest"'));
    for (const [priorMainStep, retainedIntent, mayUpload] of [['0', false, true], ['1', false, false], ['0', true, false]] as const) {
      const intent = path.join(recoveryRoot, 'npm-evidence/upload-intent.json');
      if (retainedIntent) fs.writeFileSync(intent, '{}');
      else fs.rmSync(intent, { force: true });
      const result = spawnSync('/bin/bash', ['-c', `${guard}\necho upload-authorized`], {
        cwd: recoveryRoot, encoding: 'utf8',
        env: { ...process.env, PATH: recoveryRoot, NPM_UPLOAD_MAY_HAVE_STARTED: priorMainStep },
      });
      assert.strictEqual(result.status, 0, result.stderr);
      assert.strictEqual(result.stdout.includes('upload-authorized'), mayUpload,
        'only a never-started main upload with no retained intent can mutate');
    }
    for (const [runtimeResult, mainResult, expectedMainIntent] of [
      ['failure', 'skipped', '0'], ['success', 'failure', '1'], ['success', 'success', '1'],
    ]) {
      const output = path.join(recoveryRoot, `${runtimeResult}-${mainResult}.env`);
      const steps = [
        ...['Verify exact preparation run', 'Require successful candidate push workflows',
          'Require successful automated and Computer Use acceptance', 'Publish the matching draft release',
          'Verify public tag, assets, and manifest'].map(name => ({ name, conclusion: 'success' })),
        { name: 'Verify and publish npm runtime packages with provenance', conclusion: runtimeResult },
        { name: 'Verify and publish npm package with provenance', conclusion: mainResult },
        { name: 'Wait for npm package to become public', conclusion: mainResult === 'success' ? 'failure' : 'skipped' },
      ];
      const result = spawnSync(process.execPath, ['-e', recoveryScript], { encoding: 'utf8', env: {
        ...process.env, CANDIDATE_SHA: 'a'.repeat(40), GITHUB_ENV: output,
        RUN_JSON: JSON.stringify({ event: 'workflow_dispatch', status: 'completed', conclusion: 'failure', head_sha: 'a'.repeat(40), id: 123, run_attempt: 1 }),
        JOBS_JSON: JSON.stringify({ jobs: [{ name: 'Publish verified release', steps }] }),
        WORKFLOW_JSON: JSON.stringify({ path: '.github/workflows/publish-release.yml' }),
      } });
      assert.strictEqual(result.status, 0, result.stderr);
      const flags = fs.readFileSync(output, 'utf8');
      assert(flags.includes(`NPM_UPLOAD_MAY_HAVE_STARTED=${expectedMainIntent}\n`),
        'a carrier-only failure must not mark the main package as possibly uploaded');
      assert(flags.includes('NPM_PUBLICATION_EVIDENCE_REQUIRED=1\n'), 'both artifact types retain their own upload evidence');
    }
  } finally { fs.rmSync(recoveryRoot, { recursive: true, force: true }); }
  for (const name of [
    'Verify release notes',
    'Download Linux release assets',
    'Download macOS release assets',
    'Generate checksums and manifest',
    'Require successful candidate push workflows',
    'Create or refresh draft release',
    'Publish the matching draft release',
  ]) {
    assert.strictEqual(publicationStep(name)?.if, "inputs.failed_publication_run_id == ''");
  }
  assert.strictEqual(publicationStep('Checkout recovery verifier')?.if, "inputs.failed_publication_run_id != ''");
  assert.strictEqual(publicationStep('Verify public tag, assets, and manifest')?.env.CANDIDATE_SHA, '${{ inputs.candidate_sha }}');
  assert.strictEqual(publicationStep('Verify and publish npm package with provenance')?.env.CANDIDATE_SHA, '${{ inputs.candidate_sha }}');
  assert(
    publicationStepIndex('Verify exact preparation run') < publicationStepIndex('Download verified npm tarball')
      && publicationStepIndex('Download verified npm tarball') < publicationStepIndex('Require successful candidate push workflows'),
    'publication must authenticate the successful preparation run before downloading and publishing its exact artifacts',
  );

  const watcherRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-release-watcher-'));
  try {
    const fakeBin = path.join(watcherRoot, 'bin');
    fs.mkdirSync(fakeBin);
    const fakeGh = path.join(fakeBin, 'gh');
    fs.writeFileSync(
      fakeGh,
      '#!/usr/bin/env bash\nif [[ "$1 $2" == "run list" ]]; then printf "%s\\n" "$FAKE_RUNS_JSON"; exit 0; fi\nexit 2\n',
    );
    fs.chmodSync(fakeGh, 0o755);
    const runWatcher = (runs: unknown[]) => spawnSync(
      'bash',
      ['scripts/watch-candidate-workflows.sh', 'a'.repeat(40), 'owner/repo', '0', 'once'],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH}`,
          FAKE_RUNS_JSON: JSON.stringify(runs),
          FARMING_RELEASE_WATCH_DIR: path.join(watcherRoot, 'evidence'),
        },
      },
    );
    const successful = runWatcher([
      { databaseId: 1, workflowName: 'CI', status: 'completed', conclusion: 'success' },
    ]);
    assert.strictEqual(successful.status, 0, successful.stderr);
    const pending = runWatcher([
      { databaseId: 1, workflowName: 'CI', status: 'in_progress', conclusion: '' },
    ]);
    assert.strictEqual(pending.status, 1);
    assert(pending.stderr.includes('not complete'));
    const missing = runWatcher([]);
    assert.strictEqual(missing.status, 1);
    assert(missing.stderr.includes('No candidate push workflows exist'));
  } finally {
    fs.rmSync(watcherRoot, { recursive: true, force: true });
  }

  console.log('✓ release preparation artifacts are reused by fail-closed publication');
}

run();
