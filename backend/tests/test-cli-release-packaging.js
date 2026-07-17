const assert = require('assert');
const fs = require('fs');
const path = require('path');

function run() {
  const root = path.join(__dirname, '../..');
  const configPath = path.join(root, 'pkg.config.cjs');
  const packageScript = fs.readFileSync(path.join(root, 'scripts/package-cli-release.sh'), 'utf8');
  const previousEntry = process.env.FARMING_PKG_ENTRY;
  const previousWorkerEntry = process.env.FARMING_PKG_WORKER_ENTRY;

  try {
    process.env.FARMING_PKG_ENTRY = 'backend/farming-app-cli.pkg.js';
    process.env.FARMING_PKG_WORKER_ENTRY = 'backend/terminal-screen-worker-thread.pkg.js';
    delete require.cache[require.resolve(configPath)];
    const config = require(configPath);

    assert(config.pkg.scripts.includes('backend/farming-app-cli.pkg.js'));
    assert(config.pkg.scripts.includes('backend/terminal-screen-worker-thread.pkg.js'));
    assert(config.pkg.assets.includes('node_modules/node-pty/lib/**/*.js'));
    assert.strictEqual(config.pkg.fallbackToSource, false);
  } finally {
    if (previousEntry === undefined) delete process.env.FARMING_PKG_ENTRY;
    else process.env.FARMING_PKG_ENTRY = previousEntry;
    if (previousWorkerEntry === undefined) delete process.env.FARMING_PKG_WORKER_ENTRY;
    else process.env.FARMING_PKG_WORKER_ENTRY = previousWorkerEntry;
    delete require.cache[require.resolve(configPath)];
  }

  assert(
    packageScript.includes('Failed to generate V8 bytecode.*Use --fallback-to-source')
      && packageScript.includes('refusing to publish a broken CLI'),
    'CLI packaging must fail closed when pkg silently omits bytecode and source',
  );
  assert(
    packageScript.includes('Packaged CLI failed its native startup self-check'),
    'native CLI targets must execute before their manifest is written',
  );

  console.log('✓ CLI packaging keeps the reducer worker executable and fails closed on broken pkg output');
}

run();
