const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function run() {
  const root = path.join(__dirname, '../..');
  const configPath = path.join(root, 'pkg.config.cjs');
  const packageScript = fs.readFileSync(path.join(root, 'scripts/package-cli-release.sh'), 'utf8');
  const appPackageScript = fs.readFileSync(path.join(root, 'scripts/package-release.sh'), 'utf8');
  const npmPackageScript = fs.readFileSync(path.join(root, 'scripts/package-npm-release.sh'), 'utf8');
  const npmSmokeScript = fs.readFileSync(path.join(root, 'scripts/smoke-npm-package.sh'), 'utf8');
  const npmSourceVerificationScript = fs.readFileSync(
    path.join(root, 'scripts/verify-npm-release-source.sh'),
    'utf8',
  );
  const releaseWorkflow = fs.readFileSync(path.join(root, '.github/workflows/release.yml'), 'utf8');
  const packageJson = require(path.join(root, 'package.json'));
  const farmingLauncher = fs.readFileSync(path.join(root, 'bin/farming'), 'utf8');
  const bundleCliScript = fs.readFileSync(path.join(root, 'scripts/bundle-cli-runtime.ts'), 'utf8');
  const capabilitySmokeScript = fs.readFileSync(
    path.join(root, 'scripts/smoke-capability-cli-process.ts'),
    'utf8',
  );
  const piAcpSmokeScript = fs.readFileSync(
    path.join(root, 'scripts/smoke-pi-acp-process.ts'),
    'utf8',
  );
  const prepareCodexAcpVendorScript = fs.readFileSync(
    path.join(root, 'scripts/prepare-codex-acp-vendor.ts'),
    'utf8',
  );
  const preparePiAcpVendorScript = fs.readFileSync(
    path.join(root, 'scripts/prepare-pi-acp-vendor.ts'),
    'utf8',
  );
  const packagedAcpBridge = fs.readFileSync(path.join(root, 'backend/acp/packaged-codex-acp.cts'), 'utf8');
  const packagedClaudeAcpBridge = fs.readFileSync(path.join(root, 'backend/acp/packaged-claude-acp.cts'), 'utf8');
  const packagedPiAcpBridge = fs.readFileSync(path.join(root, 'backend/acp/packaged-pi-acp.cts'), 'utf8');
  const previousEntry = process.env.FARMING_PKG_ENTRY;
  const previousWorkerEntry = process.env.FARMING_PKG_WORKER_ENTRY;
  const previousUsageWorkerEntry = process.env.FARMING_PKG_USAGE_WORKER_ENTRY;

  try {
    process.env.FARMING_PKG_ENTRY = 'backend/farming-app-cli.pkg.js';
    process.env.FARMING_PKG_WORKER_ENTRY = 'backend/terminal-screen-worker-thread.pkg.js';
    process.env.FARMING_PKG_USAGE_WORKER_ENTRY = 'backend/usage-history-worker.pkg.js';
    delete require.cache[require.resolve(configPath)];
    const config = require(configPath);

    assert(config.pkg.scripts.includes('backend/farming-app-cli.pkg.js'));
    assert(config.pkg.scripts.includes('backend/terminal-screen-worker-thread.pkg.js'));
    assert(config.pkg.scripts.includes('backend/usage-history-worker.pkg.js'));
    assert(config.pkg.assets.includes('backend/cua-tools.json'));
    assert(config.pkg.assets.includes('backend/farming-agent-bootstrap.md'));
    assert(config.pkg.assets.includes('node_modules/node-pty/lib/**/*.js'));
    assert.strictEqual(config.pkg.fallbackToSource, false);
  } finally {
    if (previousEntry === undefined) delete process.env.FARMING_PKG_ENTRY;
    else process.env.FARMING_PKG_ENTRY = previousEntry;
    if (previousWorkerEntry === undefined) delete process.env.FARMING_PKG_WORKER_ENTRY;
    else process.env.FARMING_PKG_WORKER_ENTRY = previousWorkerEntry;
    if (previousUsageWorkerEntry === undefined) delete process.env.FARMING_PKG_USAGE_WORKER_ENTRY;
    else process.env.FARMING_PKG_USAGE_WORKER_ENTRY = previousUsageWorkerEntry;
    delete require.cache[require.resolve(configPath)];
  }

  assert(
    packageScript.includes('--fallback-to-source')
      && packageScript.includes('Failed to generate V8 bytecode.*Use --fallback-to-source')
      && packageScript.includes('refusing to publish a broken CLI'),
    'CLI packaging must retain source when cross-target bytecode fails and reject missing code',
  );
  assert(
    packagedAcpBridge.includes("PACKAGED_CODEX_ACP_ARG = '--farming-codex-acp'")
      && packagedAcpBridge.includes('omitted its embedded Codex ACP runtime')
      && bundleCliScript.includes("'codex-acp-1.4.0.mjs'")
      && bundleCliScript.includes('/packaged-(?:codex|claude|pi)-acp\\.(?:cjs|cts)$/'),
    'standalone CLI must bundle a hidden entry for the pinned Codex ACP runtime',
  );
  assert(
    packageScript.includes('Packaged CLI failed its native startup self-check'),
    'native CLI targets must execute before their manifest is written',
  );
  assert(
    packagedClaudeAcpBridge.includes("PACKAGED_CLAUDE_ACP_ARG = '--farming-claude-acp'")
      && packagedClaudeAcpBridge.includes('omitted its embedded Claude ACP runtime')
      && bundleCliScript.includes("'claude-agent-acp-0.70.0.mjs'"),
    'standalone CLI must bundle a hidden entry for the pinned Claude ACP runtime',
  );
  assert(
    packagedPiAcpBridge.includes("PACKAGED_PI_ACP_ARG = '--farming-pi-acp'")
      && packagedPiAcpBridge.includes('omitted its embedded Pi ACP runtime')
      && bundleCliScript.includes("'pi-acp-0.0.33.mjs'")
      && preparePiAcpVendorScript.includes('--farming-pi-acp-state-dir')
      && preparePiAcpVendorScript.includes('--farming-append-system-prompt')
      && preparePiAcpVendorScript.includes('--farming-pi-command')
      && preparePiAcpVendorScript.includes('PI_CODING_AGENT_SESSION_DIR')
      && preparePiAcpVendorScript.includes('userAgentDir')
      && preparePiAcpVendorScript.includes('getPiCommand(farmingPiCommand || undefined)')
      && preparePiAcpVendorScript.includes('state.visited >= 5000')
      && preparePiAcpVendorScript.includes('Farming keeps adapter-side history reads bounded')
      && preparePiAcpVendorScript.includes('if (settingsSessionDir === false) return null;'),
    'standalone CLI must bundle the isolated, pinned Pi ACP runtime',
  );
  assert(
    prepareCodexAcpVendorScript.includes('fs.copyFileSync(sourceEntry, temporaryEntry)')
      && prepareCodexAcpVendorScript.includes('fs.renameSync(temporaryEntry, targetEntry)')
      && !prepareCodexAcpVendorScript.includes('fs.copyFileSync(sourceEntry, targetEntry)'),
    'Codex ACP vendor preparation must atomically replace a potentially live adapter entry',
  );
  assert(
    appPackageScript.includes(
      'cp "${PROJECT_ROOT}/backend/usage-history-scanner.generated.js"',
    ),
    'standard App packaging must include the generated TypeScript usage scanner',
  );
  assert(
    appPackageScript.includes('FARMING_RELEASE_STAGE_ROOT must be an absolute path.')
      && appPackageScript.includes('PRESERVE_STAGE_ROOT=true'),
    'release packaging must support a retained exact assembly directory for smoke testing without re-extraction',
  );
  assert(
    appPackageScript.includes('runtime_path="${source_path%.cts}.cjs"')
      && appPackageScript.includes('Generated backend runtime is missing: ${runtime_path}')
      && appPackageScript.includes('"${PROJECT_ROOT}/extensions/browser/backend"')
      && appPackageScript.includes('"${PROJECT_ROOT}/extensions/computer/backend"'),
    'standard App packaging must include generated backend, Browser, and Computer runtime modules',
  );
  assert(
    packageScript.includes('smoke-codex-acp-process.ts')
      && packageScript.includes('--arg --farming-codex-acp')
      && packageScript.includes('smoke-claude-acp-process.ts')
      && packageScript.includes('--arg --farming-claude-acp')
      && packageScript.includes('smoke-pi-acp-process.ts')
      && packageScript.includes('--arg --farming-pi-acp'),
    'native CLI targets must complete Codex, Claude, and Pi ACP initialize handshakes before their manifest is written',
  );
  assert(
    piAcpSmokeScript.includes("request(2, 'session/new'")
      && piAcpSmokeScript.includes('FARMING_FAKE_PI_LOG')
      && piAcpSmokeScript.includes('--farming-append-system-prompt')
      && piAcpSmokeScript.includes('--farming-pi-command')
      && !piAcpSmokeScript.includes('PI_ACP_PI_COMMAND')
      && piAcpSmokeScript.includes("path.join(adapterState, 'session-map.json')")
      && piAcpSmokeScript.includes("path.join(globalHome, '.pi', 'pi-acp', 'session-map.json')"),
    'Pi ACP package smoke must open a real adapter-to-Pi RPC session and prove bootstrap and state isolation',
  );
  assert(
    packageScript.includes('LICENSE.pi-acp LICENSE.pi-acp-sdk LICENSE.pi-acp-zod')
      && packageScript.includes('Standalone CLI release omitted required Pi ACP license'),
    'standalone CLI releases must ship every license embedded by the Pi ACP bundle',
  );
  assert(
    releaseWorkflow.includes(
      'for companion in LICENSE THIRD_PARTY_NOTICES.md LICENSE.pi-acp LICENSE.pi-acp-sdk LICENSE.pi-acp-zod',
    )
      && releaseWorkflow.includes('cp "releases/${FARMING_RELEASE_VERSION}/${companion}" release-upload/'),
    'GitHub releases must publish the standalone CLI notices and every embedded Pi ACP license',
  );
  assert(
    packageScript.includes('smoke-capability-cli-process.ts')
      && packageScript.includes('cp "${SOURCE_COMPUTER_TOOLS}" "${BUNDLE_COMPUTER_TOOLS}"')
      && npmSmokeScript.includes('smoke-capability-cli-process.ts')
      && capabilitySmokeScript.includes('runtimeExecutableInvocation(')
      && capabilitySmokeScript.includes('process.env.FARMING_NODE_BIN || process.execPath')
      && !packageScript.includes('smoke-browser-mcp-process.ts')
      && !npmSmokeScript.includes('smoke-browser-mcp-process.ts')
      && !npmSmokeScript.includes('smoke-computer-mcp-process.ts')
      && fs.existsSync(path.join(root, 'scripts/smoke-capability-cli-process.ts')),
    'native CLI and npm packages must smoke Browser and Computer through CLI-only contracts',
  );
  assert(
    packageScript.includes('--farming-usage-history-smoke')
      && packageScript.includes('Usage History worker + SQLite smoke'),
    'native CLI targets must run the packaged Usage worker through SQLite before release',
  );
  assert.deepStrictEqual(
    [...packageJson.bundledDependencies].sort(),
    Object.keys(packageJson.dependencies).sort(),
    'npm packages must bundle every direct production dependency',
  );
  assert(
    npmSmokeScript.includes('--ignore-scripts')
      && npmSmokeScript.includes("grep -q '^npm warn allow-scripts'")
      && npmSmokeScript.includes('frontend/skins/crt/index.html')
      && npmSmokeScript.includes('/farming/crt/shared/agent-state-bridge.js')
      && npmSmokeScript.includes('/farming/crt/shared/runtime-paths.js')
      && npmSmokeScript.includes('/farming/crt/styles/monochrome-green.css')
      && npmSmokeScript.includes('node --import tsx "${PROJECT_ROOT}/scripts/assert-no-bundled-agent-clis.ts"')
      && !npmSmokeScript.includes('node_modules/.bin/tsx')
      && !npmSmokeScript.includes('FARMING_SKIP_INSTALL_RUNTIME_PREPARE=1'),
    'npm package smoke must disable lifecycle scripts, serve CRT assets, and keep TypeScript verification compatible with loader-aware Node',
  );
  assert(
    packageJson.scripts?.preinstall == null
      && packageJson.scripts?.install == null
      && packageJson.scripts?.postinstall == null
      && !packageJson.files.includes('scripts/prepare-installed-runtime.cjs')
      && packageJson.scripts?.['prepare:packaged-runtimes'],
    'npm install must be lifecycle-script-free and release packaging must prepare runtime artifacts',
  );
  assert(
    farmingLauncher.includes('FARMING_PACKAGED_RUNTIME_ROOT')
      && farmingLauncher.includes("FARMING_RUNTIME_DOWNLOAD_POLICY = 'forbid'")
      && Object.keys(packageJson.optionalDependencies || {}).filter(name => name.startsWith('@openai/codex-')).length === 6
      && Object.keys(packageJson.optionalDependencies || {}).filter(name => name.startsWith('@anthropic-ai/claude-agent-sdk-')).length === 8,
    'npm launches must resolve exact declarative platform runtimes without startup downloads',
  );
  assert(
    npmPackageScript.includes('npm ci --omit=dev --omit=optional --ignore-scripts')
      && npmPackageScript.includes('delete rootManifest.overrides')
      && npmPackageScript.includes('rootManifest.gitHead = gitSha')
      && packageJson.overrides?.['@hono/node-server'] === '2.0.11'
      && !npmPackageScript.includes("['@hono/node-server', rootManifest.overrides?.['@hono/node-server']]")
      && npmPackageScript.includes("['dompurify', rootManifest.overrides?.dompurify]")
      && npmPackageScript.includes("['qs', rootManifest.overrides?.qs]")
      && npmPackageScript.includes("rootManifest.overrides?.['express@^4.22.2']?.['body-parser']"),
    'npm packaging must stage the locked production tree, retain reviewed development overrides, and rewrite production override edges before bundling',
  );
  assert(
    npmSmokeScript.includes('PACKAGE_TARBALL="${1:-}"')
      && npmSmokeScript.includes('scripts/package-npm-release.sh')
      && npmSmokeScript.includes('npm release tarball not found')
      && releaseWorkflow.match(/npm run release:npm:pack/g)?.length === 1
      && releaseWorkflow.includes('npm run release:npm:smoke -- "${package_tarball}"')
      && releaseWorkflow.includes('name: farming-npm-${{ inputs.release_version }}')
      && releaseWorkflow.includes('npm publish "./${package_tarball}"')
      && releaseWorkflow.includes('sha256sum --check'),
    'npm smoke and publication must consume the same staged tarball',
  );
  assert(
    npmSourceVerificationScript.includes('attempt <= MAX_ATTEMPTS')
      && npmSourceVerificationScript.includes('if [[ -n "${published_sha}" ]]')
      && npmSourceVerificationScript.includes('sleep "${RETRY_DELAY_SECONDS}"')
      && releaseWorkflow.match(/bash scripts\/verify-npm-release-source\.sh/g)?.length === 3,
    'release source verification must retry missing npm gitHead metadata and reject a conflicting revision',
  );
  assert(
    npmSmokeScript.includes('FARMING_NATIVE_PTY_HOST_PERSIST=0')
      && npmSmokeScript.includes('-- /bin/bash')
      && npmSmokeScript.includes("method: 'ping'")
      && npmSmokeScript.includes("message.id !== 'npm-smoke-ping'")
      && npmSmokeScript.includes('wait_for_process_exit "${SERVER_PID}" "Farming server"')
      && npmSmokeScript.includes('wait_for_process_exit "${NATIVE_HOST_PID}" "native PTY host"')
      && npmSmokeScript.includes('wait_for_process_exit "${MAIN_BASH_PID}" "Main bash"'),
    'npm package smoke must opt out of persistent PTY hosting and prove its Server, host, and Main bash all exit',
  );

  for (const scriptName of fs.readdirSync(path.join(root, 'scripts')).filter(name => name.endsWith('.sh'))) {
    execFileSync('bash', ['-n', path.join(root, 'scripts', scriptName)], { stdio: 'pipe' });
  }

  console.log('✓ CLI packaging keeps executable source fallback and fails closed on missing code');
}

run();
