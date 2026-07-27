const assert = require('assert');
const fs = require('fs');
const path = require('path');

function run() {
  const root = path.join(__dirname, '../..');
  const configPath = path.join(root, 'pkg.config.cjs');
  const packageScript = fs.readFileSync(path.join(root, 'scripts/package-cli-release.sh'), 'utf8');
  const appPackageScript = fs.readFileSync(path.join(root, 'scripts/package-release.sh'), 'utf8');
  const npmSmokeScript = fs.readFileSync(path.join(root, 'scripts/smoke-npm-package.sh'), 'utf8');
  const cliSmokeScript = fs.readFileSync(path.join(root, 'scripts/smoke-cli-release.sh'), 'utf8');
  const packagedAcpBridge = fs.readFileSync(path.join(root, 'backend/acp/packaged-codex-acp.js'), 'utf8');
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
    packagedAcpBridge.includes("require('../../dist/acp/codex-acp-1.1.4.js')")
      && packagedAcpBridge.includes("PACKAGED_CODEX_ACP_ARG = '--farming-codex-acp'"),
    'standalone CLI must bundle a hidden entry for the pinned Codex ACP runtime',
  );
  assert(
    packageScript.includes('Packaged CLI failed its native startup self-check'),
    'native CLI targets must execute before their manifest is written',
  );
  assert(
    cliSmokeScript.includes('--farming-browser-launch-gate')
      && cliSmokeScript.includes('Packaged Browser launch gate started its target before release.'),
    'native CLI smoke must prove the packaged Browser launch gate holds its target until release',
  );
  assert(
    appPackageScript.includes(
      'cp "${PROJECT_ROOT}/backend/usage-history-scanner.generated.js"',
    ),
    'standard App packaging must include the generated TypeScript usage scanner',
  );
  assert(
    packageScript.includes('smoke-codex-acp-process.js')
      && packageScript.includes('--arg --farming-codex-acp'),
    'native CLI targets must complete an ACP initialize handshake before their manifest is written',
  );
  assert(
    packageScript.includes('smoke-browser-mcp-process.js')
      && npmSmokeScript.includes('smoke-browser-mcp-process.js'),
    'native CLI and npm packages must expose the Browser MCP tools/list contract',
  );
  assert(
    packageScript.includes('--farming-usage-history-smoke')
      && packageScript.includes('Usage History worker + SQLite smoke'),
    'native CLI targets must run the packaged Usage worker through SQLite before release',
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

  console.log('✓ CLI packaging keeps executable source fallback and fails closed on missing code');
}

run();
