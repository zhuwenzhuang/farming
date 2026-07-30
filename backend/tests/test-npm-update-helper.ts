const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  isProcessRunning,
  runNpmUpdate,
  stopProcess,
  validatePayload,
} = require('../npm-update-helper.cjs');
const { readServerProcessIdentity } = require('../farming-app-cli.cjs');

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

function writeFakeNpm(rootDir, callsFile, { requireFallback = false, runtimeExitCode = 0 } = {}) {
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
    `fs.writeFileSync(path.join(packageRoot, 'bin', 'farming'), ${JSON.stringify([
      `const fs = require('fs');`,
      `fs.writeFileSync(${JSON.stringify(`${callsFile}.runtime`)}, JSON.stringify(process.argv.slice(2)));`,
      `process.exit(${runtimeExitCode});`,
      '',
    ].join('\n'))});`,
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

  const originalProcessKill = process.kill;
  process.kill = (pid, signal) => {
    if (pid === 2_147_483_647 && signal === 0) {
      const error = new Error('Operation not permitted') as NodeJS.ErrnoException;
      error.code = 'EPERM';
      throw error;
    }
    return originalProcessKill(pid, signal);
  };
  try {
    assert.strictEqual(isProcessRunning(2_147_483_647), true, 'EPERM must mean the process exists but is not signalable');
  } finally {
    process.kill = originalProcessKill;
  }

  const serverProcess = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  });
  try {
    await new Promise((resolve, reject) => {
      serverProcess.once('spawn', resolve);
      serverProcess.once('error', reject);
    });
    const processIdentity = await readServerProcessIdentity(serverProcess.pid);
    assert(processIdentity, 'update stop fixture must expose a process identity');
    await assert.rejects(
      stopProcess(serverProcess.pid, { ...processIdentity, startedAt: 'stale' }, 1000),
      /process identity changed/,
    );
    assert.doesNotThrow(() => process.kill(serverProcess.pid, 0));
    const exited = new Promise(resolve => serverProcess.once('exit', (code, signal) => resolve({ code, signal })));
    await stopProcess(serverProcess.pid, processIdentity, 5000);
    assert.deepStrictEqual(await exited, { code: null, signal: 'SIGKILL' });
  } finally {
    if (serverProcess.exitCode === null && serverProcess.signalCode === null) serverProcess.kill('SIGKILL');
  }

  const permissionServer = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  });
  const permissionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-npm-helper-permission.'));
  try {
    await new Promise((resolve, reject) => {
      permissionServer.once('spawn', resolve);
      permissionServer.once('error', reject);
    });
    const processIdentity = await readServerProcessIdentity(permissionServer.pid);
    assert(processIdentity, 'permission fixture must expose a process identity');
    const permissionPayload = payloadFor(permissionRoot, {
      action: 'apply',
      serverPid: permissionServer.pid,
      serverProcessIdentity: processIdentity,
    });
    const observations = path.join(permissionRoot, 'cli-observations');
    writePackage(permissionPayload.packageRoot, '2.2.5');
    writePackage(permissionPayload.stagingPackageRoot, '2.3.0');
    writeCli(permissionPayload.packageRoot, 0, observations);
    writeCli(permissionPayload.stagingPackageRoot, 0, observations);

    const originalKill = process.kill;
    process.kill = (pid, signal) => {
      if (pid === permissionServer.pid && signal === 'SIGKILL') {
        const error = new Error('Operation not permitted') as NodeJS.ErrnoException;
        error.code = 'EPERM';
        throw error;
      }
      return originalKill(pid, signal);
    };
    try {
      assert.strictEqual(isProcessRunning(permissionServer.pid), true);
      await runNpmUpdate(permissionPayload);
    } finally {
      process.kill = originalKill;
    }

    const failed = JSON.parse(fs.readFileSync(permissionPayload.stateFile, 'utf8'));
    assert.strictEqual(failed.phase, 'failed');
    assert.match(failed.error, /lacks permission/);
    assert.match(failed.error, /stop and restart Farming/);
    assert.strictEqual(isProcessRunning(permissionServer.pid), true, 'permission failure must leave the old server running');
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(permissionPayload.packageRoot, 'package.json'))).version, '2.2.5');
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(permissionPayload.stagingPackageRoot, 'package.json'))).version, '2.3.0');
    assert.strictEqual(fs.existsSync(observations), false, 'permission failure must not start either package');
  } finally {
    if (permissionServer.exitCode === null && permissionServer.signalCode === null) permissionServer.kill('SIGKILL');
  }

  const stuckServer = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  });
  try {
    await new Promise((resolve, reject) => {
      stuckServer.once('spawn', resolve);
      stuckServer.once('error', reject);
    });
    const processIdentity = await readServerProcessIdentity(stuckServer.pid);
    assert(processIdentity, 'stuck-process fixture must expose a process identity');
    const originalKill = process.kill;
    process.kill = (pid, signal) => {
      if (pid === stuckServer.pid && signal === 'SIGKILL') return true;
      return originalKill(pid, signal);
    };
    try {
      await assert.rejects(
        stopProcess(stuckServer.pid, processIdentity, 150),
        error => /did not exit after SIGKILL/.test(error.message)
          && /Stop and restart Farming manually/.test(error.message),
      );
    } finally {
      process.kill = originalKill;
    }
    assert.strictEqual(isProcessRunning(stuckServer.pid), true);
  } finally {
    if (stuckServer.exitCode === null && stuckServer.signalCode === null) stuckServer.kill('SIGKILL');
  }

  const prepareRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-npm-helper-prepare.'));
  const prepareCalls = path.join(prepareRoot, 'npm-calls');
  const preparePayload = payloadFor(prepareRoot, {
    npmCommand: writeFakeNpm(prepareRoot, prepareCalls),
  });
  writePackage(preparePayload.packageRoot, '2.2.5');
  await runNpmUpdate(preparePayload);
  const prepared = JSON.parse(fs.readFileSync(preparePayload.stateFile, 'utf8'));
  assert.strictEqual(prepared.phase, 'ready-to-restart');
  assert(prepared.runtimePreparedAt);
  assert.strictEqual(prepared.version, '2.3.0');
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(preparePayload.packageRoot, 'package.json'))).version, '2.2.5');
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(preparePayload.stagingPackageRoot, 'package.json'))).version, '2.3.0');
  const prepareArguments = JSON.parse(fs.readFileSync(prepareCalls, 'utf8').trim());
  assert.deepStrictEqual(prepareArguments.slice(0, 4), ['install', '--global', '--prefix', preparePayload.stagingPrefix]);
  assert.deepStrictEqual(
    JSON.parse(fs.readFileSync(`${prepareCalls}.runtime`, 'utf8')),
    ['runtime', 'prepare', '--config-dir', preparePayload.configDir, '--no-activate'],
  );

  const failedPrepareRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-npm-helper-prepare-failure.'));
  const failedPreparePayload = payloadFor(failedPrepareRoot, { npmCommand: '/usr/bin/false' });
  writePackage(failedPreparePayload.packageRoot, '2.2.5');
  await runNpmUpdate(failedPreparePayload);
  const failedPrepare = JSON.parse(fs.readFileSync(failedPreparePayload.stateFile, 'utf8'));
  assert.strictEqual(failedPrepare.phase, 'failed');
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(failedPreparePayload.packageRoot, 'package.json'))).version, '2.2.5');
  assert.strictEqual(fs.existsSync(failedPreparePayload.stagingPrefix), false);

  const failedRuntimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-npm-helper-runtime-failure.'));
  const failedRuntimeCalls = path.join(failedRuntimeRoot, 'npm-calls');
  const failedRuntimePayload = payloadFor(failedRuntimeRoot, {
    npmCommand: writeFakeNpm(failedRuntimeRoot, failedRuntimeCalls, { runtimeExitCode: 1 }),
  });
  writePackage(failedRuntimePayload.packageRoot, '2.2.5');
  await runNpmUpdate(failedRuntimePayload);
  const failedRuntime = JSON.parse(fs.readFileSync(failedRuntimePayload.stateFile, 'utf8'));
  assert.strictEqual(failedRuntime.phase, 'failed');
  assert.strictEqual(fs.existsSync(failedRuntimePayload.stagingPrefix), false);
  assert.strictEqual(
    JSON.parse(fs.readFileSync(path.join(failedRuntimePayload.packageRoot, 'package.json'))).version,
    '2.2.5',
    'runtime preparation failure must leave the running package untouched',
  );

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

  const handoffServer = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  });
  const handoffRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-npm-helper-handoff.'));
  try {
    await new Promise((resolve, reject) => {
      handoffServer.once('spawn', resolve);
      handoffServer.once('error', reject);
    });
    const processIdentity = await readServerProcessIdentity(handoffServer.pid);
    assert(processIdentity, 'handoff fixture must expose a process identity');
    const handoffPayload = payloadFor(handoffRoot, {
      action: 'apply',
      serverPid: handoffServer.pid,
      serverProcessIdentity: processIdentity,
    });
    const handoffObservations = path.join(handoffRoot, 'cli-observations');
    writePackage(handoffPayload.packageRoot, '2.2.5');
    writePackage(handoffPayload.stagingPackageRoot, '2.3.0');
    writeCli(handoffPayload.packageRoot, 0, handoffObservations);
    writeCli(handoffPayload.stagingPackageRoot, 0, handoffObservations);
    const exited = new Promise(resolve => handoffServer.once('exit', (code, signal) => resolve({ code, signal })));
    await runNpmUpdate(handoffPayload);
    assert.deepStrictEqual(await exited, { code: null, signal: 'SIGKILL' });
    assert.strictEqual(JSON.parse(fs.readFileSync(handoffPayload.stateFile, 'utf8')).phase, 'succeeded');
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(handoffPayload.packageRoot, 'package.json'))).version, '2.3.0');
    assert.deepStrictEqual(
      fs.readFileSync(handoffObservations, 'utf8').trim().split('\n').map(line => JSON.parse(line).version),
      ['2.3.0'],
    );
  } finally {
    if (handoffServer.exitCode === null && handoffServer.signalCode === null) handoffServer.kill('SIGKILL');
  }

  const switchFailureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-npm-helper-switch-failure.'));
  const switchFailurePayload = payloadFor(switchFailureRoot, { action: 'apply' });
  const switchFailureObservations = path.join(switchFailureRoot, 'cli-observations');
  writePackage(switchFailurePayload.packageRoot, '2.2.5');
  writePackage(switchFailurePayload.stagingPackageRoot, '2.3.0');
  writeCli(switchFailurePayload.packageRoot, 0, switchFailureObservations);
  writeCli(switchFailurePayload.stagingPackageRoot, 0, switchFailureObservations);
  const originalRenameSync = fs.renameSync;
  fs.renameSync = (source, destination) => {
    if (
      path.resolve(source) === path.resolve(switchFailurePayload.stagingPackageRoot)
      && path.resolve(destination) === path.resolve(switchFailurePayload.packageRoot)
    ) {
      const error = new Error('Injected directory switch failure') as NodeJS.ErrnoException;
      error.code = 'EIO';
      throw error;
    }
    return originalRenameSync(source, destination);
  };
  try {
    await runNpmUpdate(switchFailurePayload);
  } finally {
    fs.renameSync = originalRenameSync;
  }
  const switchRolledBack = JSON.parse(fs.readFileSync(switchFailurePayload.stateFile, 'utf8'));
  assert.strictEqual(switchRolledBack.phase, 'rolled-back');
  assert.match(switchRolledBack.error, /Injected directory switch failure/);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(switchFailurePayload.packageRoot, 'package.json'))).version, '2.2.5');
  assert.deepStrictEqual(
    fs.readFileSync(switchFailureObservations, 'utf8').trim().split('\n').map(line => JSON.parse(line).version),
    ['2.2.5'],
  );

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

  const failedRollbackRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-npm-helper-rollback-failure.'));
  const failedRollbackPayload = payloadFor(failedRollbackRoot, { action: 'apply' });
  const failedRollbackObservations = path.join(failedRollbackRoot, 'cli-observations');
  writePackage(failedRollbackPayload.packageRoot, '2.2.5');
  writePackage(failedRollbackPayload.stagingPackageRoot, '2.3.0');
  writeCli(failedRollbackPayload.packageRoot, 1, failedRollbackObservations);
  writeCli(failedRollbackPayload.stagingPackageRoot, 1, failedRollbackObservations);
  await runNpmUpdate(failedRollbackPayload);
  const rollbackFailed = JSON.parse(fs.readFileSync(failedRollbackPayload.stateFile, 'utf8'));
  assert.strictEqual(rollbackFailed.phase, 'failed');
  assert.match(rollbackFailed.error, /rollback failed/);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(failedRollbackPayload.packageRoot, 'package.json'))).version, '2.2.5');
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(failedRollbackPayload.stagingPackageRoot, 'package.json'))).version, '2.3.0');
  assert.deepStrictEqual(
    fs.readFileSync(failedRollbackObservations, 'utf8').trim().split('\n').map(line => JSON.parse(line).version),
    ['2.3.0', '2.2.5'],
  );

  console.log('✓ npm update helper covers kill permission, directory-switch, restart, and rollback failover');
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
