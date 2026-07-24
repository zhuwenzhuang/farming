#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  runBundleUpdate,
  validatePayload,
} = require('../bundle-update-helper');

function quoteShell(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function payloadFor(rootDir, overrides = {}) {
  return {
    method: 'source-deploy',
    targetMethod: 'npm',
    version: '2.3.0',
    previousVersion: '2.2.18',
    startedAt: new Date().toISOString(),
    stateFile: path.join(rootDir, 'farming-update.json'),
    logPath: path.join(rootDir, 'farming-update.log'),
    releaseDir: rootDir,
    installer: path.join(rootDir, 'install-release.sh'),
    ...overrides,
  };
}

async function run() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-bundle-update.'));
  const observedFile = path.join(rootDir, 'observed');
  fs.writeFileSync(path.join(rootDir, 'install-release.sh'), [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    `printf '%s\\n' "\${FARMING_PORT}|\${PORT}|\${FARMING_NODE_LD}|\${FARMING_NODE_LIBRARY_PATH}" > ${quoteShell(observedFile)}`,
    '',
  ].join('\n'), { mode: 0o755 });

  assert.throws(() => validatePayload({}), /Invalid bundle update stateFile/);

  const previous = {
    FARMING_PORT: process.env.FARMING_PORT,
    PORT: process.env.PORT,
    FARMING_NODE_LD: process.env.FARMING_NODE_LD,
    FARMING_NODE_LIBRARY_PATH: process.env.FARMING_NODE_LIBRARY_PATH,
  };
  process.env.FARMING_PORT = '39401';
  process.env.PORT = '39401';
  process.env.FARMING_NODE_LD = '/opt/farming/glibc/lib/ld-2.28.so';
  process.env.FARMING_NODE_LIBRARY_PATH = '/opt/farming/glibc/lib';
  try {
    await runBundleUpdate(payloadFor(rootDir));
  } finally {
    Object.entries(previous).forEach(([key, value]) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    });
  }

  assert.strictEqual(
    fs.readFileSync(observedFile, 'utf8').trim(),
    '39401|39401|/opt/farming/glibc/lib/ld-2.28.so|/opt/farming/glibc/lib',
  );
  const succeeded = JSON.parse(fs.readFileSync(path.join(rootDir, 'farming-update.json'), 'utf8'));
  assert.strictEqual(succeeded.method, 'source-deploy');
  assert.strictEqual(succeeded.targetMethod, 'npm');
  assert.strictEqual(succeeded.phase, 'succeeded');
  assert.strictEqual(succeeded.version, '2.3.0');

  const failedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-bundle-update-failed.'));
  fs.writeFileSync(path.join(failedRoot, 'install-release.sh'), '#!/usr/bin/env bash\nexit 7\n', { mode: 0o755 });
  await runBundleUpdate(payloadFor(failedRoot));
  const failed = JSON.parse(fs.readFileSync(path.join(failedRoot, 'farming-update.json'), 'utf8'));
  assert.strictEqual(failed.phase, 'failed');
  assert.match(failed.error, /exited with 7/);

  fs.rmSync(rootDir, { recursive: true, force: true });
  fs.rmSync(failedRoot, { recursive: true, force: true });
  console.log('✓ bundle update helper preserves launch settings and persists terminal state');
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
