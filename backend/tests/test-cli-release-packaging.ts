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
  const bundleCliScript = fs.readFileSync(path.join(root, 'scripts/bundle-cli-runtime.ts'), 'utf8');
  const prepareCodexAcpVendorScript = fs.readFileSync(
    path.join(root, 'scripts/prepare-codex-acp-vendor.ts'),
    'utf8',
  );
  const packagedAcpBridge = fs.readFileSync(path.join(root, 'backend/acp/packaged-codex-acp.cts'), 'utf8');
  const packagedClaudeAcpBridge = fs.readFileSync(path.join(root, 'backend/acp/packaged-claude-acp.cts'), 'utf8');
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
      && bundleCliScript.includes("'codex-acp-1.1.4.mjs'")
      && bundleCliScript.includes('/packaged-(?:codex|claude)-acp\\.(?:cjs|cts)$/'),
    'standalone CLI must bundle a hidden entry for the pinned Codex ACP runtime',
  );
  assert(
    packageScript.includes('Packaged CLI failed its native startup self-check'),
    'native CLI targets must execute before their manifest is written',
  );
  assert(
    packagedClaudeAcpBridge.includes("PACKAGED_CLAUDE_ACP_ARG = '--farming-claude-acp'")
      && packagedClaudeAcpBridge.includes('omitted its embedded Claude ACP runtime')
      && bundleCliScript.includes("'claude-agent-acp-0.59.0.mjs'"),
    'standalone CLI must bundle a hidden entry for the pinned Claude ACP runtime',
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
      && packageScript.includes('--arg --farming-claude-acp'),
    'native CLI targets must complete Codex and Claude ACP initialize handshakes before their manifest is written',
  );
  assert(
    packageScript.includes('smoke-browser-mcp-process.ts')
      && npmSmokeScript.includes('smoke-browser-mcp-process.ts'),
    'native CLI and npm packages must expose the Browser MCP tools/list contract',
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
    npmSmokeScript.includes('--offline')
      && npmSmokeScript.includes('FARMING_SKIP_INSTALL_RUNTIME_PREPARE=1')
      && npmSmokeScript.includes("grep -q '^npm warn allow-scripts'")
      && !npmSmokeScript.includes('--ignore-scripts'),
    'npm package smoke must install from the tarball alone under the default script policy without approval warnings',
  );
  assert(
    packageJson.scripts?.postinstall === 'node scripts/prepare-installed-runtime.cjs'
      && packageJson.files.includes('scripts/prepare-installed-runtime.cjs'),
    'npm install must prepare platform runtimes before Farming can start',
  );
  assert(
    npmPackageScript.includes('npm ci --omit=dev --ignore-scripts')
      && npmPackageScript.includes('delete rootManifest.overrides')
      && npmPackageScript.includes('rootManifest.gitHead = gitSha')
      && npmPackageScript.includes("['@hono/node-server', rootManifest.overrides?.['@hono/node-server']]")
      && npmPackageScript.includes("['dompurify', rootManifest.overrides?.dompurify]")
      && npmPackageScript.includes("['qs', rootManifest.overrides?.qs]")
      && npmPackageScript.includes("rootManifest.overrides?.['express@^4.22.2']?.['body-parser']"),
    'npm packaging must stage the locked production tree and rewrite reviewed override edges before bundling',
  );
  assert(
    npmSmokeScript.includes('scripts/package-npm-release.sh')
      && releaseWorkflow.includes('npm run release:npm:pack')
      && releaseWorkflow.includes('npm publish "${package_tarball}"'),
    'npm smoke and publication must consume the same staged tarball',
  );
  assert(
    npmSourceVerificationScript.includes('attempt <= MAX_ATTEMPTS')
      && npmSourceVerificationScript.includes('if [[ -n "${published_sha}" ]]')
      && npmSourceVerificationScript.includes('sleep "${RETRY_DELAY_SECONDS}"')
      && releaseWorkflow.match(/bash scripts\/verify-npm-release-source\.sh/g)?.length === 4,
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
