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
const {
  activatePackageImage,
  packageInstallationId,
  publishPreparedPackageImage,
  readCurrentPackagePointer,
  readPackageImageRef,
  resolvePackageInstallationContext,
} = require('../package-installation.cjs');

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

function writeFakeNpm(rootDir, callsFile, {
  requireFallback = false,
  runtimeExitCode = 0,
  startExitCode = 0,
} = {}) {
  const command = path.join(rootDir, 'fake-npm');
  fs.writeFileSync(command, [
    '#!/usr/bin/env node',
    `const fs = require('fs');`,
    `const path = require('path');`,
    `const args = process.argv.slice(2);`,
    `fs.appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify(args) + '\\n');`,
    `const prefix = args[args.indexOf('--prefix') + 1];`,
    ...(requireFallback ? [
      `const partialMarker = path.join(prefix, '.partial-install');`,
      `if (!args.includes('--registry')) { fs.mkdirSync(prefix, { recursive: true }); fs.writeFileSync(partialMarker, 'partial'); console.error('configured registry request failed'); process.exit(1); }`,
      `if (fs.existsSync(partialMarker)) { console.error('fallback reused partial configured-registry state'); process.exit(2); }`,
    ] : []),
    `const spec = args.find(value => value.startsWith('farming-code@'));`,
    `const version = spec.split('@').pop();`,
    `const packageRoot = path.join(prefix, 'lib', 'node_modules', 'farming-code');`,
    `fs.mkdirSync(path.join(packageRoot, 'bin'), { recursive: true });`,
    `fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name: 'farming-code', version }));`,
    `fs.writeFileSync(path.join(packageRoot, 'bin', 'farming'), ${JSON.stringify([
      `const fs = require('fs');`,
      `const path = require('path');`,
      `const args = process.argv.slice(2);`,
      `const metadata = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));`,
      `if (args[0] === 'runtime') { fs.writeFileSync(${JSON.stringify(`${callsFile}.runtime`)}, JSON.stringify(args)); process.exit(${runtimeExitCode}); }`,
      `fs.appendFileSync(${JSON.stringify(`${callsFile}.starts`)}, JSON.stringify({ version: metadata.version, cwd: process.cwd(), runServer: process.env.FARMING_RUN_SERVER, runNativeHost: process.env.FARMING_RUN_NATIVE_PTY_HOST }) + '\\n');`,
      `process.exit(${startExitCode});`,
      '',
    ].join('\n'))});`,
    '',
  ].join('\n'), { mode: 0o755 });
  return command;
}

function payloadFor(rootDir, overrides = {}) {
  const activePackageRoot = path.join(rootDir, 'bootstrap', 'farming-code');
  const installationId = packageInstallationId(activePackageRoot);
  const installationRoot = path.join(rootDir, 'installation', installationId);
  const stagingPrefix = path.join(installationRoot, 'staging', 'npm-2.3.0.test');
  return {
    action: 'prepare',
    operationId: '00000000-0000-4000-8000-000000000010',
    packageName: 'farming-code',
    targetVersion: '2.3.0',
    previousVersion: '2.2.5',
    targetIntegrity: 'sha512-target-230',
    startedAt: new Date().toISOString(),
    preparedAt: new Date().toISOString(),
    stateFile: path.join(rootDir, 'farming-update.json'),
    logPath: path.join(rootDir, 'farming-update.log'),
    activePackageRoot,
    installationId,
    installationRoot,
    bootstrapPackageRoot: activePackageRoot,
    nodePath: process.execPath,
    npmCommand: '/usr/bin/true',
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

function seedOperation(payload) {
  fs.writeFileSync(payload.stateFile, `${JSON.stringify({
    format: 'farming-update-operation-v1',
    operationId: payload.operationId,
    method: 'npm',
    phase: 'installing',
    version: payload.targetVersion,
    previousVersion: payload.previousVersion,
    startedAt: payload.startedAt,
  })}\n`);
}

async function prepareFixture(rootDir, {
  requireFallback = false,
  runtimeExitCode = 0,
  startExitCode = 0,
  runningStartExitCode = 0,
} = {}) {
  const callsFile = path.join(rootDir, 'npm-calls');
  const payload = payloadFor(rootDir, {
    npmCommand: writeFakeNpm(rootDir, callsFile, {
      requireFallback,
      runtimeExitCode,
      startExitCode,
    }),
  });
  writePackage(payload.activePackageRoot, '2.2.5');
  writeCli(payload.activePackageRoot, runningStartExitCode, `${callsFile}.starts`);
  seedOperation(payload);
  await runNpmUpdate(payload);
  const state = JSON.parse(fs.readFileSync(payload.stateFile, 'utf8'));
  return { callsFile, payload, state };
}

function applyPayloadFor(prepared, overrides = {}) {
  return {
    ...prepared.payload,
    action: 'apply',
    preparedAt: prepared.state.preparedAt,
    restartingAt: new Date().toISOString(),
    runningPackageRoot: prepared.state.runningPackageRoot,
    runningImageId: prepared.state.runningImageId,
    targetPackageRoot: prepared.state.targetPackageRoot,
    targetImageId: prepared.state.targetImageId,
    expectedCurrentImageId: prepared.state.expectedCurrentImageId,
    stagingPrefix: undefined,
    stagingPackageRoot: undefined,
    ...overrides,
  };
}

async function run() {
  const validationRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-npm-helper-validation.'));
  assert.throws(() => validatePayload({}), /Invalid npm update action/);
  assert.throws(() => validatePayload(payloadFor(validationRoot, { installationRoot: 'relative' })), /Invalid npm update installationRoot/);
  assert.throws(() => validatePayload(payloadFor(validationRoot, { targetIntegrity: '' })), /Invalid npm target integrity/);
  assert.throws(() => validatePayload(payloadFor(validationRoot, { stagingPackageRoot: validationRoot })), /Invalid npm update stagingPackageRoot/);
  assert.throws(() => validatePayload(payloadFor(validationRoot, { npmFallbackRegistryUrl: 'file:///tmp/registry' })), /Invalid npm update registry/);

  const supersededRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-npm-helper-superseded.'));
  const supersededPayload = payloadFor(supersededRoot);
  fs.writeFileSync(supersededPayload.stateFile, `${JSON.stringify({
    format: 'farming-update-operation-v1',
    operationId: '00000000-0000-4000-8000-000000000099',
    method: 'npm',
    phase: 'installing',
  })}\n`);
  await runNpmUpdate(supersededPayload);
  const supersededState = JSON.parse(fs.readFileSync(supersededPayload.stateFile, 'utf8'));
  assert.strictEqual(supersededState.operationId, '00000000-0000-4000-8000-000000000099');
  assert.match(fs.readFileSync(supersededPayload.logPath, 'utf8'), /is no longer current/);

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
    const permissionPrepared = await prepareFixture(permissionRoot);
    const permissionPayload = applyPayloadFor(permissionPrepared, {
      serverPid: permissionServer.pid,
      serverProcessIdentity: processIdentity,
    });
    const observations = `${permissionPrepared.callsFile}.starts`;

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
    assert.strictEqual(failed.phase, 'ready-to-restart');
    assert.match(failed.error, /lacks permission/);
    assert.match(failed.error, /stop and restart Farming/);
    assert.strictEqual(isProcessRunning(permissionServer.pid), true, 'permission failure must leave the old server running');
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(permissionPayload.activePackageRoot, 'package.json'))).version, '2.2.5');
    assert.strictEqual(readCurrentPackagePointer(resolvePackageInstallationContext(
      permissionPayload.activePackageRoot,
      {
        FARMING_PACKAGE_INSTALLATION_ID: permissionPayload.installationId,
        FARMING_PACKAGE_INSTALLATION_ROOT: permissionPayload.installationRoot,
        FARMING_BOOTSTRAP_PACKAGE_ROOT: permissionPayload.bootstrapPackageRoot,
      },
    )).imageId, permissionPayload.runningImageId);
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
  const prepareFixtureResult = await prepareFixture(prepareRoot);
  const { callsFile: prepareCalls, payload: preparePayload, state: prepared } = prepareFixtureResult;
  assert.strictEqual(prepared.phase, 'ready-to-restart');
  assert.strictEqual(prepared.format, 'farming-update-operation-v1');
  assert.strictEqual(prepared.operationId, preparePayload.operationId);
  assert(prepared.runtimePreparedAt);
  assert.strictEqual(prepared.version, '2.3.0');
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(preparePayload.activePackageRoot, 'package.json'))).version, '2.2.5');
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(prepared.targetPackageRoot, 'package.json'))).version, '2.3.0');
  assert.strictEqual(fs.existsSync(preparePayload.stagingPrefix), false);
  assert.strictEqual(readPackageImageRef(prepared.runningPackageRoot).imageId, prepared.runningImageId);
  assert.strictEqual(readPackageImageRef(prepared.targetPackageRoot).imageId, prepared.targetImageId);
  const prepareArguments = JSON.parse(fs.readFileSync(prepareCalls, 'utf8').trim());
  assert.deepStrictEqual(prepareArguments.slice(0, 4), ['install', '--global', '--prefix', preparePayload.stagingPrefix]);
  assert.deepStrictEqual(
    JSON.parse(fs.readFileSync(`${prepareCalls}.runtime`, 'utf8')),
    ['runtime', 'prepare', '--config-dir', preparePayload.configDir, '--no-activate'],
  );

  const failedPrepareRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-npm-helper-prepare-failure.'));
  const failedNpm = path.join(failedPrepareRoot, 'failed-npm');
  fs.mkdirSync(failedPrepareRoot, { recursive: true });
  fs.writeFileSync(failedNpm, '#!/usr/bin/env node\nconsole.error("npm error simulated registry failure");\nprocess.exit(1);\n', { mode: 0o755 });
  const failedPreparePayload = payloadFor(failedPrepareRoot, { npmCommand: failedNpm });
  writePackage(failedPreparePayload.activePackageRoot, '2.2.5');
  writeCli(failedPreparePayload.activePackageRoot, 0, path.join(failedPrepareRoot, 'starts'));
  seedOperation(failedPreparePayload);
  await runNpmUpdate(failedPreparePayload);
  const failedPrepare = JSON.parse(fs.readFileSync(failedPreparePayload.stateFile, 'utf8'));
  assert.strictEqual(failedPrepare.phase, 'failed');
  assert.match(failedPrepare.error, /npm error simulated registry failure/);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(failedPreparePayload.activePackageRoot, 'package.json'))).version, '2.2.5');
  assert.strictEqual(fs.existsSync(failedPreparePayload.stagingPrefix), false);

  const failedRuntimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-npm-helper-runtime-failure.'));
  const failedRuntimePrepared = await prepareFixture(failedRuntimeRoot, { runtimeExitCode: 1 });
  const failedRuntimePayload = failedRuntimePrepared.payload;
  const failedRuntime = failedRuntimePrepared.state;
  assert.strictEqual(failedRuntime.phase, 'failed');
  assert.strictEqual(fs.existsSync(failedRuntimePayload.stagingPrefix), false);
  assert.strictEqual(
    JSON.parse(fs.readFileSync(path.join(failedRuntimePayload.activePackageRoot, 'package.json'))).version,
    '2.2.5',
    'runtime preparation failure must leave the running package untouched',
  );
  const failedRuntimeContext = resolvePackageInstallationContext(
    failedRuntimePayload.activePackageRoot,
    {
      FARMING_PACKAGE_INSTALLATION_ID: failedRuntimePayload.installationId,
      FARMING_PACKAGE_INSTALLATION_ROOT: failedRuntimePayload.installationRoot,
      FARMING_BOOTSTRAP_PACKAGE_ROOT: failedRuntimePayload.bootstrapPackageRoot,
    },
  );
  assert(failedRuntimeContext);
  assert.strictEqual(
    fs.readdirSync(failedRuntimeContext.versionsDir).length,
    1,
    'a target must not become a published package image before runtime preparation succeeds',
  );

  const fallbackRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-npm-helper-fallback.'));
  const fallbackPrepared = await prepareFixture(fallbackRoot, { requireFallback: true });
  const fallbackCallsFile = fallbackPrepared.callsFile;
  const fallback = fallbackPrepared.state;
  assert.strictEqual(fallback.phase, 'ready-to-restart');
  const fallbackCalls = fs.readFileSync(fallbackCallsFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.strictEqual(fallbackCalls.length, 2);
  assert.strictEqual(fallbackCalls[0].includes('--registry'), false);
  assert.deepStrictEqual(fallbackCalls[1].slice(4, 6), ['--registry', 'https://registry.example.test']);

  const applyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-npm-helper-apply.'));
  const applyPrepared = await prepareFixture(applyRoot);
  const applyPayload = applyPayloadFor(applyPrepared);
  const applyObservations = `${applyPrepared.callsFile}.starts`;
  await runNpmUpdate(applyPayload);
  const succeeded = JSON.parse(fs.readFileSync(applyPayload.stateFile, 'utf8'));
  assert.strictEqual(succeeded.phase, 'succeeded');
  assert.match(succeeded.restartingAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(applyPayload.activePackageRoot, 'package.json'))).version, '2.2.5');
  assert.deepStrictEqual(
    fs.readFileSync(applyObservations, 'utf8').trim().split('\n').map(line => JSON.parse(line).version),
    ['2.3.0'],
  );
  assert.strictEqual(
    readCurrentPackagePointer(resolvePackageInstallationContext(
      applyPayload.activePackageRoot,
      {
        FARMING_PACKAGE_INSTALLATION_ID: applyPayload.installationId,
        FARMING_PACKAGE_INSTALLATION_ROOT: applyPayload.installationRoot,
        FARMING_BOOTSTRAP_PACKAGE_ROOT: applyPayload.bootstrapPackageRoot,
      },
    )).imageId,
    applyPayload.targetImageId,
  );

  const handoffServer = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  });
  const unaffectedServer = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  });
  const handoffRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-npm-helper-handoff.'));
  try {
    await Promise.all([handoffServer, unaffectedServer].map(child => new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    })));
    const processIdentity = await readServerProcessIdentity(handoffServer.pid);
    assert(processIdentity, 'handoff fixture must expose a process identity');
    const handoffPrepared = await prepareFixture(handoffRoot);
    const handoffPayload = applyPayloadFor(handoffPrepared, {
      serverPid: handoffServer.pid,
      serverProcessIdentity: processIdentity,
    });
    const handoffObservations = `${handoffPrepared.callsFile}.starts`;
    const exited = new Promise(resolve => handoffServer.once('exit', (code, signal) => resolve({ code, signal })));
    await runNpmUpdate(handoffPayload);
    assert.deepStrictEqual(await exited, { code: null, signal: 'SIGKILL' });
    assert.strictEqual(isProcessRunning(unaffectedServer.pid), true, 'another Farming instance must keep running');
    assert.strictEqual(JSON.parse(fs.readFileSync(handoffPayload.stateFile, 'utf8')).phase, 'succeeded');
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(handoffPayload.activePackageRoot, 'package.json'))).version, '2.2.5');
    assert.deepStrictEqual(
      fs.readFileSync(handoffObservations, 'utf8').trim().split('\n').map(line => JSON.parse(line).version),
      ['2.3.0'],
    );
  } finally {
    if (handoffServer.exitCode === null && handoffServer.signalCode === null) handoffServer.kill('SIGKILL');
    if (unaffectedServer.exitCode === null && unaffectedServer.signalCode === null) unaffectedServer.kill('SIGKILL');
  }

  const selectionRaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-npm-helper-selection-race.'));
  const selectionRacePrepared = await prepareFixture(selectionRaceRoot);
  const selectionRacePayload = applyPayloadFor(selectionRacePrepared);
  const selectionContext = resolvePackageInstallationContext(
    selectionRacePayload.activePackageRoot,
    {
      FARMING_PACKAGE_INSTALLATION_ID: selectionRacePayload.installationId,
      FARMING_PACKAGE_INSTALLATION_ROOT: selectionRacePayload.installationRoot,
      FARMING_BOOTSTRAP_PACKAGE_ROOT: selectionRacePayload.bootstrapPackageRoot,
    },
  );
  const newerPreparedRoot = path.join(selectionRaceRoot, 'newer-package');
  writePackage(newerPreparedRoot, '2.4.0');
  writeCli(newerPreparedRoot, 0, `${selectionRacePrepared.callsFile}.starts`);
  const newerImage = publishPreparedPackageImage(selectionContext, newerPreparedRoot, '2.4.0', 'sha512-newer-240');
  activatePackageImage(selectionContext, newerImage, selectionRacePayload.expectedCurrentImageId);
  await runNpmUpdate(selectionRacePayload);
  const selectionRaceResult = JSON.parse(fs.readFileSync(selectionRacePayload.stateFile, 'utf8'));
  assert.strictEqual(selectionRaceResult.phase, 'rolled-back');
  assert.match(selectionRaceResult.error, /selection changed/);
  assert.strictEqual(readCurrentPackagePointer(selectionContext).imageId, newerImage.imageId);
  assert.deepStrictEqual(
    fs.readFileSync(`${selectionRacePrepared.callsFile}.starts`, 'utf8').trim().split('\n').map(line => JSON.parse(line).version),
    ['2.2.5'],
  );

  const rollbackRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-npm-helper-rollback.'));
  const rollbackPrepared = await prepareFixture(rollbackRoot, { startExitCode: 1 });
  const rollbackPayload = applyPayloadFor(rollbackPrepared);
  const rollbackObservations = `${rollbackPrepared.callsFile}.starts`;
  await runNpmUpdate(rollbackPayload);
  const rolledBack = JSON.parse(fs.readFileSync(rollbackPayload.stateFile, 'utf8'));
  assert.strictEqual(rolledBack.phase, 'rolled-back');
  assert.strictEqual(rolledBack.version, '2.2.5');
  assert.strictEqual(rolledBack.attemptedVersion, '2.3.0');
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(rollbackPayload.activePackageRoot, 'package.json'))).version, '2.2.5');
  const observations = fs.readFileSync(rollbackObservations, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepStrictEqual(observations.map(item => item.version), ['2.3.0', '2.2.5']);
  observations.forEach(observation => {
    assert.strictEqual(fs.realpathSync(observation.cwd), fs.realpathSync(rollbackRoot));
    assert.strictEqual(observation.runServer, undefined);
    assert.strictEqual(observation.runNativeHost, undefined);
  });

  const failedRollbackRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-npm-helper-rollback-failure.'));
  const failedRollbackPrepared = await prepareFixture(failedRollbackRoot, {
    startExitCode: 1,
    runningStartExitCode: 1,
  });
  const failedRollbackPayload = applyPayloadFor(failedRollbackPrepared);
  const failedRollbackObservations = `${failedRollbackPrepared.callsFile}.starts`;
  await runNpmUpdate(failedRollbackPayload);
  const rollbackFailed = JSON.parse(fs.readFileSync(failedRollbackPayload.stateFile, 'utf8'));
  assert.strictEqual(rollbackFailed.phase, 'failed');
  assert.match(rollbackFailed.error, /rollback failed/);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(failedRollbackPayload.activePackageRoot, 'package.json'))).version, '2.2.5');
  assert.deepStrictEqual(
    fs.readFileSync(failedRollbackObservations, 'utf8').trim().split('\n').map(line => JSON.parse(line).version),
    ['2.3.0', '2.2.5'],
  );

  console.log('✓ npm update helper covers immutable activation, multi-instance restart, and rollback failover');
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
