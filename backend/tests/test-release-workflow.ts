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
  assert(publicationJob.includes('sha256sum --check'));
  assert(publicationJob.includes('npm publish "./${package_tarball}"'));
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
  assert.deepStrictEqual(preparationWorkflow.permissions, { contents: 'read' });
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
    preparationWorkflow.jobs['build-macos'].strategy.matrix.include
      .map(entry => `${entry.arch}:${entry.kind}`),
    ['x64:cli', 'x64:app', 'arm64:cli', 'arm64:app'],
  );
  const agentBrowserJob = preparationWorkflow.jobs['build-agent-browser'];
  assert(agentBrowserJob, 'release preparation must build the patched agent-browser runtimes');
  assert.strictEqual(agentBrowserJob.needs, 'preflight');
  assert.deepStrictEqual(
    agentBrowserJob.strategy.matrix.include.map(entry => entry.platform),
    [
      'darwin-arm64',
      'darwin-x64',
      'linux-arm64',
      'linux-x64',
      'linux-arm64-musl',
      'linux-x64-musl',
      'win32-x64',
    ],
  );
  assert.deepStrictEqual(
    agentBrowserJob.strategy.matrix.include.map(entry => entry.runner),
    ['macos-15', 'macos-15-intel', 'ubuntu-24.04-arm', 'ubuntu-24.04', 'ubuntu-24.04-arm', 'ubuntu-24.04', 'windows-latest'],
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
  assert.strictEqual(zigSetup?.if, 'matrix.zig');
  assert(zigSetup?.run.includes('ziglang==0.15.2'));
  assert(zigSetup?.run.includes('cargo-zigbuild --version 0.22.3 --locked'));
  assert.strictEqual(
    agentBrowserJob.steps.find(step => step.name === 'Build and verify patched agent-browser')?.run,
    'node scripts/build-agent-browser-runtime.mjs --platform "${{ matrix.platform }}" --output "$RUNNER_TEMP/agent-browser-artifacts"',
  );
  const nativeUpload = agentBrowserJob.steps.find(step => step.name === 'Upload patched agent-browser runtime');
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
  for (const jobName of ['build-linux', 'build-macos', 'prepare-npm']) {
    const job = preparationWorkflow.jobs[jobName];
    assert.deepStrictEqual(job.needs, ['preflight', 'build-agent-browser']);
    assert.strictEqual(job.env.FARMING_AGENT_BROWSER_ARTIFACTS, '.release-agent-browser-artifacts');
    const installScripts = job.steps.map(step => step.run ?? '').join('\n');
    assert(
      installScripts.indexOf('npm install --global npm@12.0.2') >= 0
        && installScripts.indexOf('npm install --global npm@12.0.2') < installScripts.indexOf('npm ci'),
      `${jobName} must select the pinned npm 12 resolver before npm ci`,
    );
    const download = job.steps.find(step => step.name === 'Download patched agent-browser runtimes');
    assert(download, `${jobName} must consume the verified patched agent-browser matrix`);
    assert.strictEqual(download.with.pattern, 'farming-agent-browser-*');
    assert.strictEqual(download.with.path, '.release-agent-browser-artifacts');
    assert.strictEqual(download.with['merge-multiple'], true);
  }
  for (const jobName of ['build-linux', 'build-macos']) {
    const job = preparationWorkflow.jobs[jobName];
    const chrome = job.steps.find(step => step.name === 'Setup Chrome for patched runtime smoke');
    assert.strictEqual(chrome?.if, "matrix.kind == 'app'");
    assert.strictEqual(chrome?.uses, 'browser-actions/setup-chrome@v2');
    assert.strictEqual(chrome?.with['chrome-version'], 'stable');
    const smoke = job.steps.find(step => step.name.startsWith('Smoke-test patched browser runtime on'));
    assert.strictEqual(smoke?.if, "matrix.kind == 'app'");
    assert(smoke?.run.includes('npx tsx scripts/smoke-browser-idle.ts'));
    assert(smoke?.run.includes('${{ steps.setup-chrome.outputs.chrome-path }}'));
  }
  assert(
    preparationWorkflow.jobs['build-linux'].steps
      .find(step => step.name === 'Smoke-test patched browser runtime on Linux')
      ?.run.includes('$PWD/dist/runtime/agent-browser/linux-x64/agent-browser'),
  );
  assert(
    preparationWorkflow.jobs['build-macos'].steps
      .find(step => step.name === 'Smoke-test patched browser runtime on macOS')
      ?.run.includes('$PWD/dist/runtime/agent-browser/darwin-${{ matrix.arch }}/agent-browser'),
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
    { actions: 'read', contents: 'write', 'id-token': 'write', statuses: 'read' },
  );
  assert(publicationWorkflowSource.includes("if: inputs.failed_publication_run_id == ''"));
  assert(publicationWorkflowSource.includes("if: inputs.failed_publication_run_id != ''"));
  assert(publicationWorkflowSource.includes("workflow.path !== '.github/workflows/publish-release.yml'"));
  assert(publicationWorkflowSource.includes("['Verify public tag, assets, and manifest', 'failure']"));
  const publicationSteps = publicationWorkflow.jobs['publish-release'].steps;
  const publicationStepIndex = (name: string) => publicationSteps.findIndex(step => step.name === name);
  const publicationStep = (name: string) => publicationSteps.find(step => step.name === name);
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
