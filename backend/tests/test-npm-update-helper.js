const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  runNpmUpdate,
  validatePayload,
} = require('../npm-update-helper');

function successfulNpmCommand(rootDir) {
  const packageJsonPath = path.join(rootDir, 'package.json');
  if (!fs.existsSync(packageJsonPath)) {
    fs.writeFileSync(packageJsonPath, JSON.stringify({ name: 'farming-code', version: '2.2.5' }));
  }
  const command = path.join(rootDir, 'fake-npm-success');
  if (!fs.existsSync(command)) {
    fs.writeFileSync(command, [
      '#!/usr/bin/env node',
      `const fs = require('fs');`,
      `const spec = process.argv.find(value => value.startsWith('farming-code@'));`,
      `const version = spec.split('@').pop();`,
      `fs.writeFileSync(${JSON.stringify(packageJsonPath)}, JSON.stringify({ name: 'farming-code', version }));`,
      '',
    ].join('\n'), { mode: 0o755 });
  }
  return command;
}

function payloadFor(rootDir, overrides = {}) {
  return {
    packageName: 'farming-code',
    targetVersion: '2.3.0',
    previousVersion: '2.2.5',
    startedAt: new Date().toISOString(),
    stateFile: path.join(rootDir, 'farming-update.json'),
    logPath: path.join(rootDir, 'farming-update.log'),
    cliPath: path.join(rootDir, 'bin', 'farming'),
    packageRoot: rootDir,
    nodePath: '/usr/bin/true',
    npmCommand: successfulNpmCommand(rootDir),
    npmPrefix: path.join(rootDir, 'npm-prefix'),
    npmFallbackRegistryUrl: 'https://registry.example.test',
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
  assert.throws(() => validatePayload(payloadFor(rootDir, { packageRoot: 'relative' })), /Invalid npm update packageRoot/);
  assert.throws(() => validatePayload(payloadFor(rootDir, { npmFallbackRegistryUrl: 'file:///tmp/registry' })), /Invalid npm update registry/);
  await runNpmUpdate(payloadFor(rootDir));
  const succeeded = JSON.parse(fs.readFileSync(path.join(rootDir, 'farming-update.json'), 'utf8'));
  assert.strictEqual(succeeded.phase, 'succeeded');
  assert.strictEqual(succeeded.version, '2.3.0');

  const mismatchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-npm-helper-version-mismatch.'));
  fs.mkdirSync(path.join(mismatchRoot, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(mismatchRoot, 'bin', 'farming'), '#!/usr/bin/env node\n');
  await runNpmUpdate(payloadFor(mismatchRoot, {
    npmCommand: '/usr/bin/true',
    serverPid: process.pid,
  }));
  const mismatch = JSON.parse(fs.readFileSync(path.join(mismatchRoot, 'farming-update.json'), 'utf8'));
  assert.strictEqual(mismatch.phase, 'failed');
  assert.match(mismatch.error, /version mismatch: expected 2\.3\.0, found 2\.2\.5/);

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

  const fallbackRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-npm-helper-fallback.'));
  const fallbackNpm = path.join(fallbackRoot, 'fake-npm');
  const fallbackArgumentsFile = path.join(fallbackRoot, 'npm-arguments');
  fs.mkdirSync(path.join(fallbackRoot, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(fallbackRoot, 'bin', 'farming'), '#!/usr/bin/env node\n');
  fs.writeFileSync(fallbackNpm, [
    '#!/usr/bin/env node',
    `const fs = require('fs');`,
    `const args = process.argv.slice(2);`,
    `fs.appendFileSync(${JSON.stringify(fallbackArgumentsFile)}, JSON.stringify(args) + '\\n');`,
    `if (!args.includes('--registry')) { console.error('npm error code ETARGET\\nnpm error notarget No matching version found'); process.exit(1); }`,
    `const version = args.find(value => value.startsWith('farming-code@')).split('@').pop();`,
    `fs.writeFileSync(${JSON.stringify(path.join(fallbackRoot, 'package.json'))}, JSON.stringify({ name: 'farming-code', version }));`,
    '',
  ].join('\n'), { mode: 0o755 });
  await runNpmUpdate(payloadFor(fallbackRoot, { npmCommand: fallbackNpm }));
  const fallback = JSON.parse(fs.readFileSync(path.join(fallbackRoot, 'farming-update.json'), 'utf8'));
  assert.strictEqual(fallback.phase, 'succeeded');
  const fallbackCalls = fs.readFileSync(fallbackArgumentsFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.strictEqual(fallbackCalls.length, 2);
  assert.strictEqual(fallbackCalls[0].includes('--registry'), false);
  assert.deepStrictEqual(fallbackCalls[1].slice(4, 6), ['--registry', 'https://registry.example.test']);

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
    `fs.writeFileSync(${JSON.stringify(path.join(rollbackRoot, 'package.json'))}, JSON.stringify({ name: 'farming-code', version }));`,
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
    assert.strictEqual(args.includes('--registry'), false);
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
