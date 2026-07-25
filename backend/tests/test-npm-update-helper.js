const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  runNpmUpdate,
  validatePayload,
} = require('../npm-update-helper');

function packageRoot(prefix) {
  return path.join(prefix, 'lib', 'node_modules', 'farming-code');
}

function writePackage(root, version) {
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'farming-code', version }));
}

function writeCli(root, exitCode, observationsFile) {
  fs.writeFileSync(path.join(root, 'bin', 'farming'), [
    `const fs = require('fs');`,
    `const path = require('path');`,
    `const metadata = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));`,
    `fs.appendFileSync(${JSON.stringify(observationsFile)}, JSON.stringify({ version: metadata.version, cwd: process.cwd(), runServer: process.env.FARMING_RUN_SERVER, runNativeHost: process.env.FARMING_RUN_NATIVE_PTY_HOST }) + '\\n');`,
    `process.exit(${exitCode});`,
    '',
  ].join('\n'));
}

function writeFakeNpm(rootDir, callsFile, { requireFallback = false } = {}) {
  const command = path.join(rootDir, 'fake-npm');
  fs.writeFileSync(command, [
    '#!/usr/bin/env node',
    `const fs = require('fs');`,
    `const path = require('path');`,
    `const args = process.argv.slice(2);`,
    `fs.appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify(args) + '\\n');`,
    ...(requireFallback ? [
      `if (!args.includes('--registry')) { console.error('npm error code ETARGET\\nnpm error notarget No matching version found'); process.exit(1); }`,
    ] : []),
    `const prefix = args[args.indexOf('--prefix') + 1];`,
    `const spec = args.find(value => value.startsWith('farming-code@'));`,
    `const version = spec.split('@').pop();`,
    `const packageRoot = path.join(prefix, 'lib', 'node_modules', 'farming-code');`,
    `fs.mkdirSync(path.join(packageRoot, 'bin'), { recursive: true });`,
    `fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name: 'farming-code', version }));`,
    '',
  ].join('\n'), { mode: 0o755 });
  return command;
}

function payloadFor(rootDir, overrides = {}) {
  const npmPrefix = path.join(rootDir, 'npm');
  const stagingPrefix = path.join(rootDir, 'updates', 'npm-2.3.0.test');
  return {
    action: 'prepare',
    packageName: 'farming-code',
    targetVersion: '2.3.0',
    previousVersion: '2.2.5',
    startedAt: new Date().toISOString(),
    preparedAt: new Date().toISOString(),
    stateFile: path.join(rootDir, 'farming-update.json'),
    logPath: path.join(rootDir, 'farming-update.log'),
    cliPath: path.join(packageRoot(npmPrefix), 'bin', 'farming'),
    packageRoot: packageRoot(npmPrefix),
    nodePath: process.execPath,
    npmCommand: '/usr/bin/true',
    npmPrefix,
    npmFallbackRegistryUrl: 'https://registry.example.test',
    stagingPrefix,
    stagingPackageRoot: packageRoot(stagingPrefix),
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
  const validationRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-npm-helper-validation.'));
  assert.throws(() => validatePayload({}), /Invalid npm update action/);
  assert.throws(() => validatePayload(payloadFor(validationRoot, { npmPrefix: 'relative' })), /Invalid npm update npmPrefix/);
  assert.throws(() => validatePayload(payloadFor(validationRoot, { packageRoot: 'relative' })), /Invalid npm update packageRoot/);
  assert.throws(() => validatePayload(payloadFor(validationRoot, { stagingPackageRoot: validationRoot })), /Invalid npm update stagingPackageRoot/);
  assert.throws(() => validatePayload(payloadFor(validationRoot, { npmFallbackRegistryUrl: 'file:///tmp/registry' })), /Invalid npm update registry/);

  const prepareRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-npm-helper-prepare.'));
  const prepareCalls = path.join(prepareRoot, 'npm-calls');
  const preparePayload = payloadFor(prepareRoot, {
    npmCommand: writeFakeNpm(prepareRoot, prepareCalls),
  });
  writePackage(preparePayload.packageRoot, '2.2.5');
  await runNpmUpdate(preparePayload);
  const prepared = JSON.parse(fs.readFileSync(preparePayload.stateFile, 'utf8'));
  assert.strictEqual(prepared.phase, 'ready-to-restart');
  assert.strictEqual(prepared.version, '2.3.0');
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(preparePayload.packageRoot, 'package.json'))).version, '2.2.5');
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(preparePayload.stagingPackageRoot, 'package.json'))).version, '2.3.0');
  const prepareArguments = JSON.parse(fs.readFileSync(prepareCalls, 'utf8').trim());
  assert.deepStrictEqual(prepareArguments.slice(0, 4), ['install', '--global', '--prefix', preparePayload.stagingPrefix]);

  const failedPrepareRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-npm-helper-prepare-failure.'));
  const failedPreparePayload = payloadFor(failedPrepareRoot, { npmCommand: '/usr/bin/false' });
  writePackage(failedPreparePayload.packageRoot, '2.2.5');
  await runNpmUpdate(failedPreparePayload);
  const failedPrepare = JSON.parse(fs.readFileSync(failedPreparePayload.stateFile, 'utf8'));
  assert.strictEqual(failedPrepare.phase, 'failed');
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(failedPreparePayload.packageRoot, 'package.json'))).version, '2.2.5');
  assert.strictEqual(fs.existsSync(failedPreparePayload.stagingPrefix), false);

  const fallbackRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-npm-helper-fallback.'));
  const fallbackCallsFile = path.join(fallbackRoot, 'npm-calls');
  const fallbackPayload = payloadFor(fallbackRoot, {
    npmCommand: writeFakeNpm(fallbackRoot, fallbackCallsFile, { requireFallback: true }),
  });
  writePackage(fallbackPayload.packageRoot, '2.2.5');
  await runNpmUpdate(fallbackPayload);
  const fallback = JSON.parse(fs.readFileSync(fallbackPayload.stateFile, 'utf8'));
  assert.strictEqual(fallback.phase, 'ready-to-restart');
  const fallbackCalls = fs.readFileSync(fallbackCallsFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.strictEqual(fallbackCalls.length, 2);
  assert.strictEqual(fallbackCalls[0].includes('--registry'), false);
  assert.deepStrictEqual(fallbackCalls[1].slice(4, 6), ['--registry', 'https://registry.example.test']);

  const applyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-npm-helper-apply.'));
  const applyPayload = payloadFor(applyRoot, { action: 'apply' });
  const applyObservations = path.join(applyRoot, 'cli-observations');
  writePackage(applyPayload.packageRoot, '2.2.5');
  writePackage(applyPayload.stagingPackageRoot, '2.3.0');
  writeCli(applyPayload.packageRoot, 0, applyObservations);
  writeCli(applyPayload.stagingPackageRoot, 0, applyObservations);
  await runNpmUpdate(applyPayload);
  const succeeded = JSON.parse(fs.readFileSync(applyPayload.stateFile, 'utf8'));
  assert.strictEqual(succeeded.phase, 'succeeded');
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(applyPayload.packageRoot, 'package.json'))).version, '2.3.0');
  assert.strictEqual(fs.existsSync(applyPayload.stagingPrefix), false);

  const rollbackRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-npm-helper-rollback.'));
  const rollbackPayload = payloadFor(rollbackRoot, { action: 'apply' });
  const rollbackObservations = path.join(rollbackRoot, 'cli-observations');
  writePackage(rollbackPayload.packageRoot, '2.2.5');
  writePackage(rollbackPayload.stagingPackageRoot, '2.3.0');
  writeCli(rollbackPayload.packageRoot, 0, rollbackObservations);
  writeCli(rollbackPayload.stagingPackageRoot, 1, rollbackObservations);
  await runNpmUpdate(rollbackPayload);
  const rolledBack = JSON.parse(fs.readFileSync(rollbackPayload.stateFile, 'utf8'));
  assert.strictEqual(rolledBack.phase, 'rolled-back');
  assert.strictEqual(rolledBack.version, '2.2.5');
  assert.strictEqual(rolledBack.attemptedVersion, '2.3.0');
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(rollbackPayload.packageRoot, 'package.json'))).version, '2.2.5');
  assert.strictEqual(fs.existsSync(rollbackPayload.stagingPrefix), false);
  const observations = fs.readFileSync(rollbackObservations, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepStrictEqual(observations.map(item => item.version), ['2.3.0', '2.2.5']);
  observations.forEach(observation => {
    assert.strictEqual(fs.realpathSync(observation.cwd), fs.realpathSync(rollbackRoot));
    assert.strictEqual(observation.runServer, undefined);
    assert.strictEqual(observation.runNativeHost, undefined);
  });

  console.log('✓ npm update helper stages separately, applies on restart, and rolls back directory switches');
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
