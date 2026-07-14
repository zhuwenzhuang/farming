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
    npmPrefix: path.join(rootDir, 'npm-prefix'),
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
  assert.throws(() => validatePayload(payloadFor(rootDir, { npmPrefix: 'relative' })), /Invalid npm update npmPrefix/);
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
  const npmArgumentsFile = path.join(rollbackRoot, 'npm-arguments');
  const childObservationsFile = path.join(rollbackRoot, 'child-observations');
  const fakeCli = path.join(rollbackRoot, 'fake-farming.js');
  fs.writeFileSync(fakeNpm, [
    '#!/usr/bin/env node',
    `const fs = require('fs');`,
    `const version = process.argv.find(value => value.startsWith('farming-code@')).split('@').pop();`,
    `fs.writeFileSync(${JSON.stringify(installedVersionFile)}, version);`,
    `fs.appendFileSync(${JSON.stringify(npmArgumentsFile)}, JSON.stringify(process.argv.slice(2)) + '\\n');`,
    `fs.appendFileSync(${JSON.stringify(childObservationsFile)}, JSON.stringify({ kind: 'npm', cwd: process.cwd(), runServer: process.env.FARMING_RUN_SERVER, runNativeHost: process.env.FARMING_RUN_NATIVE_PTY_HOST }) + '\\n');`,
    '',
  ].join('\n'), { mode: 0o755 });
  fs.writeFileSync(fakeCli, [
    `const fs = require('fs');`,
    `fs.appendFileSync(${JSON.stringify(childObservationsFile)}, JSON.stringify({ kind: 'cli', cwd: process.cwd(), runServer: process.env.FARMING_RUN_SERVER, runNativeHost: process.env.FARMING_RUN_NATIVE_PTY_HOST }) + '\\n');`,
    `const version = fs.readFileSync(${JSON.stringify(installedVersionFile)}, 'utf8');`,
    `process.exit(version === '2.3.0' ? 1 : 0);`,
    '',
  ].join('\n'));
  const previousRunServer = process.env.FARMING_RUN_SERVER;
  const previousRunNativeHost = process.env.FARMING_RUN_NATIVE_PTY_HOST;
  process.env.FARMING_RUN_SERVER = '1';
  process.env.FARMING_RUN_NATIVE_PTY_HOST = '1';
  try {
    await runNpmUpdate(payloadFor(rollbackRoot, {
      cliPath: fakeCli,
      nodePath: process.execPath,
      npmCommand: fakeNpm,
    }));
  } finally {
    if (previousRunServer === undefined) delete process.env.FARMING_RUN_SERVER;
    else process.env.FARMING_RUN_SERVER = previousRunServer;
    if (previousRunNativeHost === undefined) delete process.env.FARMING_RUN_NATIVE_PTY_HOST;
    else process.env.FARMING_RUN_NATIVE_PTY_HOST = previousRunNativeHost;
  }
  const rolledBack = JSON.parse(fs.readFileSync(path.join(rollbackRoot, 'farming-update.json'), 'utf8'));
  assert.strictEqual(rolledBack.phase, 'rolled-back');
  assert.strictEqual(rolledBack.version, '2.2.5');
  assert.strictEqual(rolledBack.attemptedVersion, '2.3.0');
  assert.strictEqual(fs.readFileSync(installedVersionFile, 'utf8'), '2.2.5');
  const npmCalls = fs.readFileSync(npmArgumentsFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.strictEqual(npmCalls.length, 2);
  npmCalls.forEach(args => {
    assert.deepStrictEqual(args.slice(0, 4), ['install', '--global', '--prefix', path.join(rollbackRoot, 'npm-prefix')]);
  });
  const childObservations = fs.readFileSync(childObservationsFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.strictEqual(childObservations.length, 4);
  childObservations.forEach(observation => {
    assert.strictEqual(fs.realpathSync(observation.cwd), fs.realpathSync(rollbackRoot));
    assert.strictEqual(observation.runServer, undefined);
    assert.strictEqual(observation.runNativeHost, undefined);
  });

  console.log('✓ npm update helper preserves the old server on install failure and rolls back failed restarts');
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
