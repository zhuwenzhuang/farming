const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  runNpmUpdate,
  validatePayload,
} = require('../npm-update-helper');

function payloadFor(rootDir, overrides = {}) {
  return {
    packageName: 'farming-code',
    targetVersion: '2.3.0',
    previousVersion: '2.2.5',
    startedAt: new Date().toISOString(),
    stateFile: path.join(rootDir, 'farming-update.json'),
    logPath: path.join(rootDir, 'farming-update.log'),
    cliPath: path.join(rootDir, 'bin', 'farming'),
    nodePath: '/usr/bin/true',
    npmCommand: '/usr/bin/true',
    serverPid: 0,
    configDir: rootDir,
    port: '6694',
    basePath: '/farming',
    serverHome: '',
    disableAuth: true,
    ...overrides,
  };
}

async function run() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-npm-helper.'));
  fs.mkdirSync(path.join(rootDir, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(rootDir, 'bin', 'farming'), '#!/usr/bin/env node\n');

  assert.throws(() => validatePayload({}), /Invalid npm package name/);
  await runNpmUpdate(payloadFor(rootDir));
  const succeeded = JSON.parse(fs.readFileSync(path.join(rootDir, 'farming-update.json'), 'utf8'));
  assert.strictEqual(succeeded.phase, 'succeeded');
  assert.strictEqual(succeeded.version, '2.3.0');

  const failedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-npm-helper-failed.'));
  fs.mkdirSync(path.join(failedRoot, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(failedRoot, 'bin', 'farming'), '#!/usr/bin/env node\n');
  await runNpmUpdate(payloadFor(failedRoot, {
    npmCommand: '/usr/bin/false',
    serverPid: process.pid,
  }));
  const failed = JSON.parse(fs.readFileSync(path.join(failedRoot, 'farming-update.json'), 'utf8'));
  assert.strictEqual(failed.phase, 'failed');
  assert.match(failed.error, /exited/);

  const rollbackRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-npm-helper-rollback.'));
  const installedVersionFile = path.join(rollbackRoot, 'installed-version');
  const fakeNpm = path.join(rollbackRoot, 'fake-npm');
  const fakeCli = path.join(rollbackRoot, 'fake-farming.js');
  fs.writeFileSync(fakeNpm, [
    '#!/usr/bin/env node',
    `const fs = require('fs');`,
    `const version = process.argv.find(value => value.startsWith('farming-code@')).split('@').pop();`,
    `fs.writeFileSync(${JSON.stringify(installedVersionFile)}, version);`,
    '',
  ].join('\n'), { mode: 0o755 });
  fs.writeFileSync(fakeCli, [
    `const fs = require('fs');`,
    `const version = fs.readFileSync(${JSON.stringify(installedVersionFile)}, 'utf8');`,
    `process.exit(version === '2.3.0' ? 1 : 0);`,
    '',
  ].join('\n'));
  await runNpmUpdate(payloadFor(rollbackRoot, {
    cliPath: fakeCli,
    nodePath: process.execPath,
    npmCommand: fakeNpm,
  }));
  const rolledBack = JSON.parse(fs.readFileSync(path.join(rollbackRoot, 'farming-update.json'), 'utf8'));
  assert.strictEqual(rolledBack.phase, 'rolled-back');
  assert.strictEqual(rolledBack.version, '2.2.5');
  assert.strictEqual(rolledBack.attemptedVersion, '2.3.0');
  assert.strictEqual(fs.readFileSync(installedVersionFile, 'utf8'), '2.2.5');

  console.log('✓ npm update helper preserves the old server on install failure and rolls back failed restarts');
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
