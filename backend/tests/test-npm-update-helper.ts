const assert = require('assert');
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

type ChildProcess = import('child_process').ChildProcess;

const {
  isProcessRunning,
  runNpmUpdate,
  stopProcess,
  validatePayload,
} = require('../npm-update-helper.cjs');
const {
  acquireUpdateStateLock,
  commitUpdateOperationState,
  readUpdateOperationOwnership,
  releaseUpdateStateLock,
  removeUpdateOperationState,
  tryReclaimDeadClaim,
  updateStateLockDir,
} = require('../update-operation-state.cjs');
const { readServerProcessIdentity } = require('../farming-app-cli.cjs');
const { matchingProcessIdentity } = require('../server-process-identity.cjs');
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

  // --- Update-state ownership commit atomicity -------------------------------
  const OPERATION_FORMAT = 'farming-update-operation-v1';
  const OPERATION_A = '00000000-0000-4000-8000-0000000000aa';
  const OPERATION_B = '00000000-0000-4000-8000-0000000000bb';

  function writeBlockingFakeNpm(rootDir, markerBase) {
    const command = path.join(rootDir, 'blocking-fake-npm');
    fs.writeFileSync(command, [
      '#!/usr/bin/env node',
      'const fs = require("fs");',
      'const path = require("path");',
      'const { execFileSync } = require("child_process");',
      'const args = process.argv.slice(2);',
      'const prefix = args[args.indexOf("--prefix") + 1];',
      'const spec = args.find(v => v.startsWith("farming-code@"));',
      'const version = spec.split("@").pop();',
      'const psOut = execFileSync("/bin/ps", ["-p", String(process.pid), "-o", "pid=", "-o", "pgid=", "-o", "lstart="], {',
      '  encoding: "utf8",',
      '  env: { ...process.env, LANG: "C", LC_ALL: "C", TZ: "UTC" },',
      '}).trim();',
      'const psMatch = psOut.match(/^(\\d+)\\s+(\\d+)\\s+(.+)$/);',
      'if (!psMatch || Number(psMatch[1]) !== process.pid) process.exit(70);',
      `const waitingMarker = ${JSON.stringify(`${markerBase}.waiting`)};`,
      `const claimDir = ${JSON.stringify(markerBase)} + ".claim-" + process.pid;`,
      'fs.mkdirSync(claimDir);',
      'const waitingTmp = waitingMarker + "." + process.pid + ".tmp";',
      '// Publish the ownership claim before the marker becomes visible; roll',
      '// both back exactly if marker publication fails.',
      'try {',
      '  fs.writeFileSync(waitingTmp, JSON.stringify({',
      '    format: "ps-lstart-c-utc-v1",',
      '    pid: process.pid,',
      '    processGroupId: Number(psMatch[2]),',
      '    startedAt: psMatch[3].trim(),',
      '  }));',
      '  fs.renameSync(waitingTmp, waitingMarker);',
      '} catch (publishError) {',
      '  try { fs.rmSync(waitingTmp, { force: true }); } catch (cleanupError) {}',
      '  try { fs.rmSync(claimDir, { recursive: true, force: true }); } catch (cleanupError) {}',
      '  process.exit(71);',
      '}',
      '// Normal-path cleanup: this child owns its claim directory and must',
      '// remove it on every normal exit; the parent removes it after a kill.',
      'try {',
      `  while (!fs.existsSync(${JSON.stringify(`${markerBase}.release`)})) {`,
      '    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);',
      '  }',
      '  const pkg = path.join(prefix, "lib", "node_modules", "farming-code");',
      '  fs.mkdirSync(path.join(pkg, "bin"), { recursive: true });',
      '  fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "farming-code", version }));',
      '  fs.writeFileSync(path.join(pkg, "bin", "farming"), "process.exit(0);\\n");',
      '} finally {',
      '  try { fs.rmSync(waitingMarker, { force: true }); } catch (cleanupError) {}',
      '  try { fs.rmSync(claimDir, { recursive: true, force: true }); } catch (cleanupError) {}',
      '}',
      'process.exit(0);',
      '',
    ].join('\n'), { mode: 0o755 });
    return command;
  }

  async function waitForFile(file, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (fs.existsSync(file)) return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error(`Timed out waiting for ${file}`);
  }

  // Exact cleanup contract: attach the exit listener first, recheck state,
  // send an exact SIGKILL, reject on timeout, and guarantee the postcondition
  // "terminated". Fixture removal happens only after this resolves, so it can
  // never race a dying process or proceed while a live child remains.
  async function killChildBounded(child: ChildProcess): Promise<void> {
    let notifyExit = () => {};
    const exitSignal = new Promise<void>(resolve => {
      notifyExit = resolve;
    });
    child.once('exit', () => notifyExit());
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
    // Recheck after attaching: exit may already have been emitted.
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Timed out waiting for child PID ${child.pid} to terminate`)),
        2000,
      );
      exitSignal.then(() => {
        clearTimeout(timer);
        resolve();
      });
    });
    if (child.exitCode === null && child.signalCode === null) {
      throw new Error(`Child PID ${child.pid} did not terminate`);
    }
  }

  // Bounded settlement for a run promise whose internal child may be blocked
  // on a test marker: the marker is always released in the scenario's finally,
  // and the promise must settle visibly before fixture cleanup proceeds.
  async function settleBounded(promise: Promise<unknown>, label: string, timeoutMs = 3000): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Timed out waiting for ${label} to settle`)),
        timeoutMs,
      );
      promise.then(
        () => {
          clearTimeout(timer);
          resolve();
        },
        error => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  // Exact bounded termination for the internal blocking fake-npm process a
  // scenario spawns. The fake process writes its own immutable identity
  // (pid+pgid+startedAt/format) into the .waiting marker before signaling.
  // This helper parses that expected identity and only kills when the current
  // identity at that PID matches it exactly. An absent or mismatched current
  // identity means the original child is already gone (the PID may have been
  // reused by an unrelated process that must never be killed). Lookup, kill,
  // or termination-proof failures throw visibly unless reconciled absent via
  // ESRCH.
  async function terminateBlockingFakeNpm(markerBase: string): Promise<void> {
    const markerErrorCode = (error: unknown): string => (
      error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
    );
    // Only ENOENT can mean "no marker yet": the child may still be starting,
    // so wait bounded before concluding there is nothing to terminate. Any
    // other read failure (EACCES, EISDIR, EIO, ...) fails visibly.
    let markerText: string | null = null;
    const markerDeadline = Date.now() + 500;
    for (;;) {
      try {
        markerText = fs.readFileSync(`${markerBase}.waiting`, 'utf8').trim();
        break;
      } catch (error) {
        if (markerErrorCode(error) !== 'ENOENT') {
          throw new Error(`Cannot read the blocking fake-npm marker ${markerBase}.waiting`, { cause: error });
        }
        if (Date.now() >= markerDeadline) return;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }
    let expected: { format?: unknown; pid?: unknown; processGroupId?: unknown; startedAt?: unknown } | null = null;
    try {
      expected = JSON.parse(markerText);
    } catch {
      expected = null;
    }
    if (
      !expected
      || expected.format !== 'ps-lstart-c-utc-v1'
      || !Number.isSafeInteger(Number(expected.pid))
      || Number(expected.pid) <= 0
      || !Number.isSafeInteger(Number(expected.processGroupId))
      || Number(expected.processGroupId) <= 0
      || typeof expected.startedAt !== 'string'
      || !expected.startedAt
    ) {
      throw new Error(`Blocking fake-npm marker ${markerBase}.waiting carries no valid process identity`);
    }
    const expectedPid = Number(expected.pid);
    // Marker-ownership proof: the blocking child must have created its
    // exclusive claim directory after publishing the marker. Without it, the
    // marker's writer cannot be proven and nothing may be killed.
    const markerClaimDir = `${markerBase}.claim-${expectedPid}`;
    let markerClaimed = false;
    try {
      markerClaimed = fs.statSync(markerClaimDir).isDirectory();
    } catch {
      markerClaimed = false;
    }
    if (!markerClaimed) {
      throw new Error(
        `Cannot prove marker ownership of the blocking fake-npm marker for PID ${expectedPid}; refusing to kill`,
      );
    }
    let terminationError: unknown = null;
    try {
      await (async () => {
        const reconciledAbsent = (): boolean => {
          try {
            process.kill(expectedPid, 0);
            return false;
          } catch (error) {
            if (markerErrorCode(error) === 'ESRCH') return true;
            throw new Error(
              `Cannot reconcile the blocking fake-npm PID ${expectedPid}: signalability check failed`,
              { cause: error },
            );
          }
        };
        let current = null;
        try {
          current = readServerProcessIdentity(expectedPid);
        } catch (error) {
          if (reconciledAbsent()) return;
          throw new Error(`Cannot verify the blocking fake-npm identity for PID ${expectedPid}`, { cause: error });
        }
        if (!current) {
          if (reconciledAbsent()) return;
          throw new Error(`Blocking fake-npm PID ${expectedPid} exists without a readable identity; refusing to kill`);
        }
        if (!matchingProcessIdentity(expected, current)) {
          // PID reused by an unrelated process: the original child is gone
          // and the unrelated occupant must never be killed here.
          return;
        }
        // Exact match: kill exactly the process the marker describes.
        try {
          process.kill(expectedPid, 'SIGKILL');
        } catch (error) {
          if (markerErrorCode(error) === 'ESRCH') return;
          throw new Error(`Failed to signal the blocking fake-npm PID ${expectedPid}`, { cause: error });
        }
        const deadline = Date.now() + 2000;
        while (Date.now() < deadline) {
          let now = null;
          try {
            now = readServerProcessIdentity(expectedPid);
          } catch (error) {
            if (reconciledAbsent()) return;
            throw new Error(`Termination-proof lookup failed for PID ${expectedPid}`, { cause: error });
          }
          if (!now) {
            if (reconciledAbsent()) return;
            continue; // Transient inspection gap; keep proving termination.
          }
          // A reused PID proves the original child is dead.
          if (!matchingProcessIdentity(expected, now)) return;
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        throw new Error(`Timed out proving termination of the blocking fake-npm PID ${expectedPid}`);
      })();
    } catch (error) {
      terminationError = error;
    }
    let claimCleanupError: unknown = null;
    try {
      fs.rmSync(markerClaimDir, { recursive: true, force: true });
    } catch (cleanupError) {
      // A leftover claim directory can still authorize a later kill, so its
      // cleanup failure must be preserved even when termination also failed.
      claimCleanupError = new Error(
        `Failed to remove the marker claim directory ${markerClaimDir}`,
        { cause: cleanupError },
      );
    }
    if (terminationError && claimCleanupError) {
      throw new AggregateError(
        [terminationError, claimCleanupError],
        `Blocking fake-npm termination and claim cleanup both failed for PID ${expectedPid}`,
      );
    }
    if (terminationError) throw terminationError;
    if (claimCleanupError) throw claimCleanupError;
  }

  // Every fixture root and spawned child created by the update-state tests is
  // registered here so cleanup runs on every assertion/error path: children
  // get exact confirmed termination before any fixture root is removed.
  const b2FixtureRoots: string[] = [];
  const b2Children: ChildProcess[] = [];
  const trackedRoot = (prefix: string): string => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    b2FixtureRoots.push(root);
    return root;
  };
  const trackedChild = (child: ChildProcess): ChildProcess => {
    b2Children.push(child);
    return child;
  };
  let b2BodyError: unknown = null;
  let b2CleanupError: Error | null = null;
  try {
  // A conditional commit must fail closed when this process cannot prove its
  // own identity, and must not leave any claim behind.
  const identityRoot = trackedRoot('farming-update-lock-identity.');
  const identityStateFile = path.join(identityRoot, 'farming-update.json');
  assert.throws(
    () => acquireUpdateStateLock(identityStateFile, { readProcessIdentity: () => null }),
    /cannot prove its own identity/,
    'lock acquisition must fail closed without exact self identity',
  );
  assert.strictEqual(fs.existsSync(updateStateLockDir(identityStateFile)), false);
  fs.rmSync(identityRoot, { recursive: true, force: true });

  // A live holder is never preempted: a competing acquisition waits and then
  // fails visibly, and the holder's claim stays intact.
  const liveRoot = trackedRoot('farming-update-lock-live.');
  const liveStateFile = path.join(liveRoot, 'farming-update.json');
  const liveClaim = acquireUpdateStateLock(liveStateFile);
  try {
    assert.throws(
      () => commitUpdateOperationState(
        liveStateFile,
        null,
        { format: OPERATION_FORMAT, operationId: OPERATION_B, phase: 'installing' },
        { lockTimeoutMs: 150, lockPollMs: 10 },
      ),
      (error) => /live PID/.test(error.message),
      'a live lock holder must not be preempted; waiting must fail visibly',
    );
    const holderAfter = JSON.parse(fs.readFileSync(path.join(updateStateLockDir(liveStateFile), 'owner.json'), 'utf8'));
    assert.strictEqual(holderAfter.token, liveClaim.token, 'the live claim must survive the failed preemption');
  } finally {
    assert.strictEqual(releaseUpdateStateLock(liveStateFile, liveClaim), true);
  }
  assert.strictEqual(fs.existsSync(updateStateLockDir(liveStateFile)), false);
  fs.rmSync(liveRoot, { recursive: true, force: true });

  // Release must only remove the exact claim it was given: a later holder's
  // claim stays untouched. A claim proven replaced satisfies the release goal
  // (it no longer holds the lock) without touching the current holder.
  const releaseRoot = trackedRoot('farming-update-lock-release.');
  const releaseStateFile = path.join(releaseRoot, 'farming-update.json');
  const earlyClaim = acquireUpdateStateLock(releaseStateFile);
  const laterClaim = {
    ...earlyClaim,
    token: '00000000-0000-4000-8000-00000000later',
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(
    path.join(updateStateLockDir(releaseStateFile), 'owner.json'),
    `${JSON.stringify(laterClaim, null, 2)}\n`,
  );
  assert.strictEqual(
    releaseUpdateStateLock(releaseStateFile, earlyClaim),
    true,
    'a proven-replaced claim must release without touching the current holder',
  );
  const survivingClaim = JSON.parse(fs.readFileSync(path.join(updateStateLockDir(releaseStateFile), 'owner.json'), 'utf8'));
  assert.strictEqual(survivingClaim.token, laterClaim.token, 'the later holder claim must survive the stale release');
  assert.strictEqual(releaseUpdateStateLock(releaseStateFile, laterClaim), true);
  fs.rmSync(releaseRoot, { recursive: true, force: true });

  // An unreadable owner.json during release must not let commit silently
  // report success while the live claim remains held.
  const unreadableRoot = trackedRoot('farming-update-lock-unreadable.');
  const unreadableStateFile = path.join(unreadableRoot, 'farming-update.json');
  const originalReadFileSync = fs.readFileSync;
  const unreadableStart = Date.now();
  fs.readFileSync = (...readArgs) => {
    if (String(readArgs[0]) === path.join(updateStateLockDir(unreadableStateFile), 'owner.json')) {
      const error = new Error(`EACCES: permission denied, open '${readArgs[0]}'`) as NodeJS.ErrnoException;
      error.code = 'EACCES';
      throw error;
    }
    return originalReadFileSync(...readArgs);
  };
  try {
    assert.throws(
      () => commitUpdateOperationState(
        unreadableStateFile,
        null,
        { format: OPERATION_FORMAT, operationId: OPERATION_A, phase: 'installing' },
        { lockTimeoutMs: 150, lockPollMs: 10 },
      ),
      (error) => /could not be proven released/.test(error.message)
        && error.code === 'FARMING_UPDATE_STATE_LOCK',
      'a written-but-unreleased commit must fail visibly instead of reporting success',
    );
  } finally {
    fs.readFileSync = originalReadFileSync;
  }
  assert(Date.now() - unreadableStart < 2000, 'release verification must stay bounded');
  assert.strictEqual(
    JSON.parse(fs.readFileSync(unreadableStateFile, 'utf8')).phase,
    'installing',
    'the state write itself must have succeeded before the release failure',
  );
  assert(
    fs.existsSync(updateStateLockDir(unreadableStateFile)),
    'the live claim must remain when release could not be proven',
  );
  // Recovery: once readable again, the next mutation first releases the exact
  // retained claim in-process, then acquires and commits normally.
  assert.strictEqual(
    commitUpdateOperationState(
      unreadableStateFile,
      { format: OPERATION_FORMAT, operationId: OPERATION_A },
      { format: OPERATION_FORMAT, operationId: OPERATION_A, phase: 'ready-to-restart' },
      { lockTimeoutMs: 150, lockPollMs: 10 },
    ),
    true,
    'the next same-process mutation must recover the exact pending release before acquiring',
  );
  assert.strictEqual(
    JSON.parse(fs.readFileSync(unreadableStateFile, 'utf8')).phase,
    'ready-to-restart',
  );
  assert.strictEqual(
    fs.existsSync(updateStateLockDir(unreadableStateFile)),
    false,
    'same-process recovery must leave no live claim behind',
  );

  // A persistent rename failure during release must not let remove silently
  // report success while the live claim remains held.
  const renamefailRoot = trackedRoot('farming-update-lock-renamefail.');
  const renamefailStateFile = path.join(renamefailRoot, 'farming-update.json');
  const originalRenameSyncForRelease = fs.renameSync;
  fs.renameSync = (...renameArgs) => {
    if (String(renameArgs[0]) === updateStateLockDir(renamefailStateFile)) {
      const error = new Error(`EACCES: permission denied, rename '${renameArgs[0]}'`) as NodeJS.ErrnoException;
      error.code = 'EACCES';
      throw error;
    }
    return originalRenameSyncForRelease(...renameArgs);
  };
  try {
    assert.throws(
      () => removeUpdateOperationState(renamefailStateFile, { lockTimeoutMs: 150, lockPollMs: 10 }),
      (error) => /could not be proven released/.test(error.message)
        && error.code === 'FARMING_UPDATE_STATE_LOCK',
      'a removed-but-unreleased state must fail visibly instead of reporting success',
    );
  } finally {
    fs.renameSync = originalRenameSyncForRelease;
  }
  assert(
    fs.existsSync(updateStateLockDir(renamefailStateFile)),
    'the live claim must remain when release rename could not be proven',
  );
  const renamefailLeftover = JSON.parse(
    fs.readFileSync(path.join(updateStateLockDir(renamefailStateFile), 'owner.json'), 'utf8'),
  );
  assert.strictEqual(releaseUpdateStateLock(renamefailStateFile, renamefailLeftover), true);

  // A conditional commit that loses its ownership check must still surface
  // release uncertainty instead of returning false with a live claim held.
  const supersededReleaseRoot = trackedRoot('farming-update-lock-supersededrel.');
  const supersededReleaseStateFile = path.join(supersededReleaseRoot, 'farming-update.json');
  fs.writeFileSync(supersededReleaseStateFile, `${JSON.stringify({
    format: OPERATION_FORMAT,
    operationId: OPERATION_B,
    phase: 'installing',
  })}\n`);
  const originalRenameSyncForSuperseded = fs.renameSync;
  fs.renameSync = (...renameArgs) => {
    if (String(renameArgs[0]) === updateStateLockDir(supersededReleaseStateFile)) {
      const error = new Error(`EACCES: permission denied, rename '${renameArgs[0]}'`) as NodeJS.ErrnoException;
      error.code = 'EACCES';
      throw error;
    }
    return originalRenameSyncForSuperseded(...renameArgs);
  };
  try {
    assert.throws(
      () => commitUpdateOperationState(
        supersededReleaseStateFile,
        { operationId: OPERATION_A },
        { format: OPERATION_FORMAT, operationId: OPERATION_A, phase: 'ready-to-restart' },
        { lockTimeoutMs: 150, lockPollMs: 10 },
      ),
      (error) => /could not be proven released/.test(error.message)
        && error.code === 'FARMING_UPDATE_STATE_LOCK',
      'a superseded commit with a failed release must throw instead of returning false',
    );
  } finally {
    fs.renameSync = originalRenameSyncForSuperseded;
  }
  assert.strictEqual(
    JSON.parse(fs.readFileSync(supersededReleaseStateFile, 'utf8')).operationId,
    OPERATION_B,
    'the superseded state must stay untouched',
  );
  const supersededLeftover = JSON.parse(
    fs.readFileSync(path.join(updateStateLockDir(supersededReleaseStateFile), 'owner.json'), 'utf8'),
  );
  assert.strictEqual(releaseUpdateStateLock(supersededReleaseStateFile, supersededLeftover), true);

  // A write failure plus a release failure must surface both: the primary
  // write error preserved, with the release uncertainty attached.
  const bothfailRoot = trackedRoot('farming-update-lock-bothfail.');
  const bothfailStateFile = path.join(bothfailRoot, 'farming-update.json');
  const originalWriteFileSyncForBoth = fs.writeFileSync;
  const originalRenameSyncForBoth = fs.renameSync;
  fs.writeFileSync = (...writeArgs) => {
    const writeTarget = String(writeArgs[0]);
    // writeJsonAtomic's state temp is `${stateFile}.<pid>.<uuid>.tmp` in the
    // same directory; claim-owner temps live in subdirectories and must not
    // be hit by this injection.
    const tempSuffix = writeTarget.startsWith(`${bothfailStateFile}.`)
      ? writeTarget.slice(bothfailStateFile.length + 1)
      : null;
    if (tempSuffix !== null && writeTarget.endsWith('.tmp') && !tempSuffix.includes(path.sep)) {
      const error = new Error(`EACCES: permission denied, open '${writeArgs[0]}'`) as NodeJS.ErrnoException;
      error.code = 'EACCES';
      throw error;
    }
    return originalWriteFileSyncForBoth(...writeArgs);
  };
  fs.renameSync = (...renameArgs) => {
    if (String(renameArgs[0]) === updateStateLockDir(bothfailStateFile)) {
      const error = new Error(`EACCES: permission denied, rename '${renameArgs[0]}'`) as NodeJS.ErrnoException;
      error.code = 'EACCES';
      throw error;
    }
    return originalRenameSyncForBoth(...renameArgs);
  };
  try {
    try {
      commitUpdateOperationState(
        bothfailStateFile,
        null,
        { format: OPERATION_FORMAT, operationId: OPERATION_A, phase: 'installing' },
        { lockTimeoutMs: 150, lockPollMs: 10 },
      );
      assert.fail('a write failure plus a release failure must throw');
    } catch (error) {
      assert(error instanceof AggregateError, 'write + release failure must surface as AggregateError');
      assert.strictEqual(error.errors.length, 2, 'both the write error and the release uncertainty must be included');
      assert.strictEqual(error.errors[0].code, 'EACCES', 'the primary write error must be preserved first');
      assert.strictEqual(error.errors[1].code, 'FARMING_UPDATE_STATE_LOCK');
    }
  } finally {
    fs.writeFileSync = originalWriteFileSyncForBoth;
    fs.renameSync = originalRenameSyncForBoth;
  }
  const bothfailLeftover = JSON.parse(
    fs.readFileSync(path.join(updateStateLockDir(bothfailStateFile), 'owner.json'), 'utf8'),
  );
  assert.strictEqual(releaseUpdateStateLock(bothfailStateFile, bothfailLeftover), true);

  // Repeated rename ENOENT during release must cross the shared bounded
  // boundary: finite attempts, no sleep at zero timeout, capped sleeps after.
  const enoentReleaseRoot = trackedRoot('farming-update-lock-enoentrel.');
  const enoentReleaseStateFile = path.join(enoentReleaseRoot, 'farming-update.json');
  const enoentReleaseClaim = acquireUpdateStateLock(enoentReleaseStateFile);
  const originalRenameSyncForEnoent = fs.renameSync;
  fs.renameSync = (...renameArgs) => {
    if (String(renameArgs[0]) === updateStateLockDir(enoentReleaseStateFile)) {
      const error = new Error(`ENOENT: no such file or directory, rename '${renameArgs[0]}'`) as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    }
    return originalRenameSyncForEnoent(...renameArgs);
  };
  try {
    let zeroSleeps = 0;
    const zeroStart = Date.now();
    assert.strictEqual(
      releaseUpdateStateLock(enoentReleaseStateFile, enoentReleaseClaim, {
        lockTimeoutMs: 0,
        sleep: () => {
          zeroSleeps += 1;
        },
      }),
      false,
      'a raced release must fail closed at zero timeout',
    );
    assert(Date.now() - zeroStart < 1000, 'zero-timeout release must stay bounded');
    assert.strictEqual(zeroSleeps, 0, 'a zero-timeout release must never sleep');
    const boundedSleeps = [];
    const boundedStart = Date.now();
    assert.strictEqual(
      releaseUpdateStateLock(enoentReleaseStateFile, enoentReleaseClaim, {
        lockTimeoutMs: 60,
        lockPollMs: 5,
        sleep: ms => {
          boundedSleeps.push(ms);
        },
      }),
      false,
      'a repeatedly raced release must fail closed at the bounded deadline',
    );
    assert(Date.now() - boundedStart < 2000, 'raced release retries must stay bounded');
    assert(boundedSleeps.length > 0, 'the bounded path must have retried');
    for (const requested of boundedSleeps) {
      assert(requested > 0 && requested <= 60, `each retry sleep must stay inside the deadline, got ${requested}ms`);
    }
  } finally {
    fs.renameSync = originalRenameSyncForEnoent;
  }
  // Recovery: the exact claim releases cleanly once renames work again.
  assert.strictEqual(releaseUpdateStateLock(enoentReleaseStateFile, enoentReleaseClaim), true);

  // A claim whose exact identity is proven dead is broken automatically.
  const staleRoot = trackedRoot('farming-update-lock-stale.');
  const staleStateFile = path.join(staleRoot, 'farming-update.json');
  const deadChild = trackedChild(spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }));
  await new Promise((resolve, reject) => {
    deadChild.once('spawn', resolve);
    deadChild.once('error', reject);
  });
  const deadIdentity = await readServerProcessIdentity(deadChild.pid);
  assert(deadIdentity, 'stale-lock fixture must expose a process identity');
  deadChild.kill('SIGKILL');
  await new Promise(resolve => deadChild.once('exit', resolve));
  fs.mkdirSync(updateStateLockDir(staleStateFile), { recursive: true });
  fs.writeFileSync(path.join(updateStateLockDir(staleStateFile), 'owner.json'), `${JSON.stringify({
    format: 'farming-update-state-lock-v1',
    pid: deadIdentity.pid,
    processGroupId: deadIdentity.processGroupId,
    startedAt: deadIdentity.startedAt,
    token: '00000000-0000-4000-8000-00000000dead',
    createdAt: new Date().toISOString(),
  }, null, 2)}\n`);
  assert.strictEqual(
    commitUpdateOperationState(
      staleStateFile,
      null,
      { format: OPERATION_FORMAT, operationId: OPERATION_B, phase: 'installing' },
    ),
    true,
    'a claim proven dead by exact identity must be broken automatically',
  );
  assert.strictEqual(fs.existsSync(updateStateLockDir(staleStateFile)), false);
  assert.strictEqual(readUpdateOperationOwnership(staleStateFile).operationId, OPERATION_B);
  fs.rmSync(staleRoot, { recursive: true, force: true });

  // Stale recovery is claim-scoped: a contender acting on a stale dead
  // observation must never rename away a newer live claim (ABA).
  const abaRoot = trackedRoot('farming-update-lock-aba.');
  const abaStateFile = path.join(abaRoot, 'farming-update.json');
  const markerDirFor = token => path.join(
    updateStateLockDir(abaStateFile),
    `.reclaim-${crypto.createHash('sha256').update(String(token)).digest('hex')}`,
  );
  const abaChild = trackedChild(spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }));
  try {
    await new Promise((resolve, reject) => {
      abaChild.once('spawn', resolve);
      abaChild.once('error', reject);
    });
    const abaDeadIdentity = await readServerProcessIdentity(abaChild.pid);
    assert(abaDeadIdentity, 'ABA fixture must expose a process identity');
    abaChild.kill('SIGKILL');
    await new Promise(resolve => abaChild.once('exit', resolve));
    const deadClaimA = {
      format: 'farming-update-state-lock-v1',
      pid: abaDeadIdentity.pid,
      processGroupId: abaDeadIdentity.processGroupId,
      startedAt: abaDeadIdentity.startedAt,
      token: '00000000-0000-4000-8000-00000000aba-a',
      createdAt: new Date().toISOString(),
    };
    fs.mkdirSync(updateStateLockDir(abaStateFile), { recursive: true });
    fs.writeFileSync(
      path.join(updateStateLockDir(abaStateFile), 'owner.json'),
      `${JSON.stringify(deadClaimA, null, 2)}\n`,
    );
    // Contender 1 reclaims the dead claim A.
    assert.strictEqual(tryReclaimDeadClaim(abaStateFile, deadClaimA, readServerProcessIdentity), 'reclaimed');
    assert.strictEqual(fs.existsSync(updateStateLockDir(abaStateFile)), false);
    // A new live claim B is published while contender 2 still holds its
    // stale observation of A. B already carries its own reclaim marker.
    const liveClaimB = acquireUpdateStateLock(abaStateFile);
    try {
      fs.mkdirSync(markerDirFor(liveClaimB.token), { recursive: true });
      assert.strictEqual(
        tryReclaimDeadClaim(abaStateFile, deadClaimA, readServerProcessIdentity),
        'failed',
        'a stale dead observation must not reclaim a newer live claim',
      );
      const survivingHolder = JSON.parse(
        fs.readFileSync(path.join(updateStateLockDir(abaStateFile), 'owner.json'), 'utf8'),
      );
      assert.strictEqual(survivingHolder.token, liveClaimB.token, 'the live claim must survive the stale contender');
      assert(
        fs.existsSync(markerDirFor(liveClaimB.token)),
        'cleanup must never remove another claim\'s token-keyed marker',
      );
      assert.strictEqual(
        fs.existsSync(markerDirFor(deadClaimA.token)),
        false,
        'a backoff must remove only its own token-keyed marker',
      );
    } finally {
      // The fixture created B's marker synthetically; a real recovery would
      // have removed it. Clear it on every path so the exact owner-only
      // release shape is restored before releasing.
      fs.rmSync(markerDirFor(liveClaimB.token), { recursive: true, force: true });
      assert.strictEqual(releaseUpdateStateLock(abaStateFile, liveClaimB), true);
    }

    // A crashed breaker leaves the exact token-keyed marker behind; recovery
    // then fails closed visibly at the bounded deadline instead of guessing.
    fs.mkdirSync(updateStateLockDir(abaStateFile), { recursive: true });
    fs.writeFileSync(
      path.join(updateStateLockDir(abaStateFile), 'owner.json'),
      `${JSON.stringify(deadClaimA, null, 2)}\n`,
    );
    fs.mkdirSync(markerDirFor(deadClaimA.token), { recursive: true });
    assert.strictEqual(
      tryReclaimDeadClaim(abaStateFile, deadClaimA, readServerProcessIdentity),
      'failed',
      'a crashed reclaim marker must stop further recovery attempts',
    );
    const crashedMarkerStart = Date.now();
    assert.throws(
      () => acquireUpdateStateLock(abaStateFile, { lockTimeoutMs: 150, lockPollMs: 10 }),
      (error) => /recovering the proven-dead update state lock/.test(error.message)
        && error.code === 'FARMING_UPDATE_STATE_LOCK',
      'a blocked reclaim must fail visibly at the bounded deadline',
    );
    assert(Date.now() - crashedMarkerStart < 2000, 'the blocked reclaim deadline must stay bounded');
    assert(fs.existsSync(path.join(updateStateLockDir(abaStateFile), 'owner.json')));
  } finally {
    await killChildBounded(abaChild);
    fs.rmSync(abaRoot, { recursive: true, force: true });
  }

  // A persistent rename failure must honor timeout + poll and fail with the
  // lock error code; it must never loop silently past the deadline.
  const eaccesRoot = trackedRoot('farming-update-lock-eacces.');
  const eaccesStateFile = path.join(eaccesRoot, 'farming-update.json');
  const eaccesChild = trackedChild(spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }));
  try {
    await new Promise((resolve, reject) => {
      eaccesChild.once('spawn', resolve);
      eaccesChild.once('error', reject);
    });
    const eaccesDeadIdentity = await readServerProcessIdentity(eaccesChild.pid);
    assert(eaccesDeadIdentity, 'EACCES fixture must expose a process identity');
    eaccesChild.kill('SIGKILL');
    await new Promise(resolve => eaccesChild.once('exit', resolve));
    fs.mkdirSync(updateStateLockDir(eaccesStateFile), { recursive: true });
    fs.writeFileSync(
      path.join(updateStateLockDir(eaccesStateFile), 'owner.json'),
      `${JSON.stringify({
        format: 'farming-update-state-lock-v1',
        pid: eaccesDeadIdentity.pid,
        processGroupId: eaccesDeadIdentity.processGroupId,
        startedAt: eaccesDeadIdentity.startedAt,
        token: '00000000-0000-4000-8000-00000000eacces',
        createdAt: new Date().toISOString(),
      }, null, 2)}\n`,
    );
    const originalRenameSync = fs.renameSync;
    fs.renameSync = (...renameArgs) => {
      if (String(renameArgs[0]) === updateStateLockDir(eaccesStateFile)) {
        const error = new Error(`EACCES: permission denied, rename '${renameArgs[0]}'`) as NodeJS.ErrnoException;
        error.code = 'EACCES';
        throw error;
      }
      return originalRenameSync(...renameArgs);
    };
    try {
      const eaccesStart = Date.now();
      assert.throws(
        () => acquireUpdateStateLock(eaccesStateFile, { lockTimeoutMs: 150, lockPollMs: 10 }),
        (error) => /recovering the proven-dead update state lock/.test(error.message)
          && error.code === 'FARMING_UPDATE_STATE_LOCK',
        'a persistent rename failure must end at the bounded deadline',
      );
      assert(Date.now() - eaccesStart < 2000, 'recovery retries must honor the acquisition deadline');
    } finally {
      fs.renameSync = originalRenameSync;
    }
    assert(
      fs.existsSync(path.join(updateStateLockDir(eaccesStateFile), 'owner.json')),
      'the dead claim must remain until a recovery actually succeeds',
    );
  } finally {
    await killChildBounded(eaccesChild);
    fs.rmSync(eaccesRoot, { recursive: true, force: true });
  }

  // A persistent ENOENT during claim publication must also honor the
  // bounded deadline instead of retrying in a tight loop.
  const enoentRoot = trackedRoot('farming-update-lock-enoent.');
  const enoentStateFile = path.join(enoentRoot, 'farming-update.json');
  const originalMkdirSync = fs.mkdirSync;
  fs.mkdirSync = (...mkdirArgs) => {
    const target = String(mkdirArgs[0]);
    if (target.startsWith(`${updateStateLockDir(enoentStateFile)}.claim-`)) {
      const error = new Error(`ENOENT: no such file or directory, mkdir '${target}'`) as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    }
    return originalMkdirSync(...mkdirArgs);
  };
  try {
    const enoentStart = Date.now();
    assert.throws(
      () => acquireUpdateStateLock(enoentStateFile, { lockTimeoutMs: 150, lockPollMs: 10 }),
      (error) => /Config directory is unstable/.test(error.message)
        && error.code === 'FARMING_UPDATE_STATE_LOCK',
      'a persistent publication ENOENT must end at the bounded deadline',
    );
    assert(Date.now() - enoentStart < 2000, 'publication retries must honor the acquisition deadline');
  } finally {
    fs.mkdirSync = originalMkdirSync;
  }
  assert.strictEqual(fs.existsSync(updateStateLockDir(enoentStateFile)), false);
  fs.rmSync(enoentRoot, { recursive: true, force: true });

  // A holder that exists but whose identity cannot be read is unknown, not
  // dead: the claim must never be broken, and waiting fails visibly.
  const unknownRoot = trackedRoot('farming-update-lock-unknown.');
  const unknownStateFile = path.join(unknownRoot, 'farming-update.json');
  const unknownChild = trackedChild(spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }));
  try {
    await new Promise((resolve, reject) => {
      unknownChild.once('spawn', resolve);
      unknownChild.once('error', reject);
    });
    const unknownIdentity = await readServerProcessIdentity(unknownChild.pid);
    assert(unknownIdentity, 'unknown-holder fixture must expose a process identity');
    fs.mkdirSync(updateStateLockDir(unknownStateFile), { recursive: true });
    fs.writeFileSync(path.join(updateStateLockDir(unknownStateFile), 'owner.json'), `${JSON.stringify({
      format: 'farming-update-state-lock-v1',
      pid: unknownIdentity.pid,
      processGroupId: unknownIdentity.processGroupId,
      startedAt: unknownIdentity.startedAt,
      token: '00000000-0000-4000-8000-00000000unknown',
      createdAt: new Date().toISOString(),
    }, null, 2)}\n`);
    assert.throws(
      () => commitUpdateOperationState(
        unknownStateFile,
        null,
        { format: OPERATION_FORMAT, operationId: OPERATION_B, phase: 'installing' },
        {
          lockTimeoutMs: 150,
          lockPollMs: 10,
          readProcessIdentity: pid => (pid === unknownChild.pid ? null : readServerProcessIdentity(pid)),
        },
      ),
      (error) => /unverifiable update state lock/.test(error.message),
      'an unknown holder must time out visibly instead of being preempted',
    );
    assert(
      fs.existsSync(path.join(updateStateLockDir(unknownStateFile), 'owner.json')),
      'the unverifiable claim must survive the failed acquisition',
    );
    assert.strictEqual(isProcessRunning(unknownChild.pid), true);
    assert.strictEqual(fs.existsSync(unknownStateFile), false, 'no state may publish while the holder is unknown');
  } finally {
    await killChildBounded(unknownChild);
    fs.rmSync(unknownRoot, { recursive: true, force: true });
  }

  // Conditional commits require the exact operation format, not only the id.
  const formatRoot = trackedRoot('farming-update-lock-format.');
  const formatStateFile = path.join(formatRoot, 'farming-update.json');
  fs.writeFileSync(formatStateFile, `${JSON.stringify({
    format: 'foreign-format-v9',
    operationId: OPERATION_A,
    phase: 'installing',
  })}\n`);
  assert.strictEqual(
    commitUpdateOperationState(formatStateFile, { format: OPERATION_FORMAT, operationId: OPERATION_A }, {
      format: OPERATION_FORMAT,
      operationId: OPERATION_A,
      phase: 'preparing-runtimes',
    }),
    false,
    'a foreign state format must supersede a matching operation id',
  );
  assert.strictEqual(JSON.parse(fs.readFileSync(formatStateFile, 'utf8')).format, 'foreign-format-v9');
  assert.strictEqual(
    commitUpdateOperationState(formatStateFile, { operationId: OPERATION_A }, {
      format: OPERATION_FORMAT,
      operationId: OPERATION_A,
      phase: 'preparing-runtimes',
    }),
    true,
  );
  fs.rmSync(formatRoot, { recursive: true, force: true });

  // The no-polling property is proven by counting, not wall-clock: a
  // zero-timeout writer never sleeps and performs a bounded number of
  // identity reads (one self read, one holder liveness read).
  const countRoot = trackedRoot('farming-update-lock-count.');
  const countStateFile = path.join(countRoot, 'farming-update.json');
  const countHolder = acquireUpdateStateLock(countStateFile);
  try {
    let sleeps = 0;
    let identityReads = 0;
    const countingReader = pid => {
      identityReads += 1;
      return readServerProcessIdentity(pid);
    };
    assert.throws(
      () => acquireUpdateStateLock(countStateFile, {
        lockTimeoutMs: 0,
        readProcessIdentity: countingReader,
        sleep: () => {
          sleeps += 1;
        },
      }),
      (error) => error.code === 'FARMING_UPDATE_STATE_LOCK',
      'a zero-timeout writer under a live claim must fail visibly',
    );
    assert.strictEqual(sleeps, 0, 'a zero-timeout writer must never sleep');
    assert.strictEqual(identityReads, 2, 'one self read plus one holder read: bounded attempts');
  } finally {
    assert.strictEqual(releaseUpdateStateLock(countStateFile, countHolder), true);
  }
  fs.rmSync(countRoot, { recursive: true, force: true });

  // Acquisition never overshoots the deadline by a full poll interval: with
  // a poll far larger than the timeout, every requested sleep stays within
  // the remaining budget and the call returns near the deadline.
  const overshootRoot = trackedRoot('farming-update-lock-overshoot.');
  const overshootStateFile = path.join(overshootRoot, 'farming-update.json');
  const overshootHolder = acquireUpdateStateLock(overshootStateFile);
  try {
    const selfIdentity = readServerProcessIdentity(process.pid);
    assert(selfIdentity, 'overshoot fixture must expose a process identity');
    const fastReader = pid => (pid === process.pid ? selfIdentity : readServerProcessIdentity(pid));
    const requestedSleeps = [];
    const overshootStart = Date.now();
    assert.throws(
      () => acquireUpdateStateLock(overshootStateFile, {
        lockTimeoutMs: 40,
        lockPollMs: 5000,
        readProcessIdentity: fastReader,
        sleep: ms => {
          requestedSleeps.push(ms);
        },
      }),
      (error) => /live PID/.test(error.message) && error.code === 'FARMING_UPDATE_STATE_LOCK',
      'a live holder must bound the wait at the deadline',
    );
    const overshootElapsed = Date.now() - overshootStart;
    assert(overshootElapsed < 2000, 'acquisition must return near the deadline, not after a full poll interval');
    assert(requestedSleeps.length > 0, 'the poll path must have run at least once');
    for (const requested of requestedSleeps) {
      assert(requested <= 40, `no sleep may exceed the remaining deadline, got ${requested}ms`);
    }

    // A caller-supplied zero poll must not produce a 0ms busy loop: the
    // normalized poll keeps every sleep positive and inside the deadline.
    const zeroPollSleeps = [];
    const zeroPollStart = Date.now();
    assert.throws(
      () => acquireUpdateStateLock(overshootStateFile, {
        lockTimeoutMs: 40,
        lockPollMs: 0,
        readProcessIdentity: fastReader,
        sleep: ms => {
          zeroPollSleeps.push(ms);
        },
      }),
      (error) => error.code === 'FARMING_UPDATE_STATE_LOCK',
      'a zero poll must still end at the bounded deadline',
    );
    assert(Date.now() - zeroPollStart < 2000, 'a zero poll must stay bounded by the deadline');
    assert(zeroPollSleeps.length > 0, 'the zero-poll path must have slept, not busy-looped without waiting');
    for (const requested of zeroPollSleeps) {
      assert(requested >= 1 && requested <= 40, `zero-poll sleeps must be positive and bounded, got ${requested}ms`);
    }
  } finally {
    assert.strictEqual(releaseUpdateStateLock(overshootStateFile, overshootHolder), true);
  }
  fs.rmSync(overshootRoot, { recursive: true, force: true });

  // A failed self-identity read must not be cached: the next attempt re-reads
  // and succeeds once the reader can prove the identity.
  const retryRoot = trackedRoot('farming-update-lock-retry.');
  const retryStateFile = path.join(retryRoot, 'farming-update.json');
  let identityFlaky = true;
  const flakyReader = pid => (identityFlaky ? null : readServerProcessIdentity(pid));
  assert.throws(
    () => acquireUpdateStateLock(retryStateFile, { readProcessIdentity: flakyReader }),
    /cannot prove its own identity/,
    'an unprovable self identity must fail acquisition closed',
  );
  assert.strictEqual(fs.existsSync(updateStateLockDir(retryStateFile)), false);
  identityFlaky = false;
  const retryClaim = acquireUpdateStateLock(retryStateFile, { readProcessIdentity: flakyReader });
  try {
    assert(retryClaim.token, 'a later attempt must re-read the identity instead of reusing the failure');
  } finally {
    assert.strictEqual(releaseUpdateStateLock(retryStateFile, retryClaim), true);
  }
  fs.rmSync(retryRoot, { recursive: true, force: true });

  // Claim publication is atomic and cleans up after itself: no staging
  // directory survives a normal cycle, and an aged orphan is swept.
  const atomicRoot = trackedRoot('farming-update-lock-atomic.');
  const atomicStateFile = path.join(atomicRoot, 'farming-update.json');
  const orphan = `${updateStateLockDir(atomicStateFile)}.claim-999999-orphan`;
  fs.mkdirSync(orphan, { recursive: true });
  fs.writeFileSync(path.join(orphan, 'owner.json'), '{}');
  const orphanPast = new Date(Date.now() - 5 * 60 * 1000);
  fs.utimesSync(orphan, orphanPast, orphanPast);
  const atomicClaim = acquireUpdateStateLock(atomicStateFile);
  try {
    const leftovers = fs.readdirSync(atomicRoot).filter(entry => entry.includes('.claim-'));
    assert.deepStrictEqual(leftovers, [], 'a published claim must leave no staging directory behind');
  } finally {
    assert.strictEqual(releaseUpdateStateLock(atomicStateFile, atomicClaim), true);
  }
  fs.rmSync(atomicRoot, { recursive: true, force: true });

  // The TOCTOU contract: while operation A commits, the claim is held, so
  // a protocol competitor cannot interleave between A's ownership check and
  // publication. After A releases, the takeover wins serialization.
  const windowRoot = trackedRoot('farming-update-lock-window.');
  const windowCallsFile = path.join(windowRoot, 'npm-calls');
  const windowPayload = payloadFor(windowRoot, {
    operationId: OPERATION_A,
    npmCommand: writeFakeNpm(windowRoot, windowCallsFile),
  });
  writePackage(windowPayload.activePackageRoot, '2.2.5');
  writeCli(windowPayload.activePackageRoot, 0, `${windowCallsFile}.starts`);
  seedOperation({ ...windowPayload, operationId: OPERATION_A });
  const windowProbe = { outcome: '' };
  const originalWriteFileSync = fs.writeFileSync;
  fs.writeFileSync = (...writeArgs) => {
    const [target, data] = writeArgs;
    if (String(target).startsWith(`${windowPayload.stateFile}.`) && String(target).endsWith('.tmp')) {
      let parsed = null;
      try {
        parsed = JSON.parse(String(data));
      } catch {
        parsed = null;
      }
      if (parsed && parsed.operationId === OPERATION_A && parsed.phase === 'preparing-runtimes') {
        try {
          commitUpdateOperationState(
            windowPayload.stateFile,
            null,
            { format: OPERATION_FORMAT, operationId: OPERATION_B, phase: 'installing' },
            { lockTimeoutMs: 200, lockPollMs: 5 },
          );
          windowProbe.outcome = 'acquired-inside-window';
        } catch (error) {
          windowProbe.outcome = /live PID/.test(error.message) ? 'locked-out' : `error:${error.message}`;
        }
      }
    }
    return originalWriteFileSync(...writeArgs);
  };
  try {
    await runNpmUpdate(windowPayload);
  } finally {
    fs.writeFileSync = originalWriteFileSync;
  }
  assert.strictEqual(
    windowProbe.outcome,
    'locked-out',
    'no protocol competitor may interleave inside a commit window',
  );
  assert.strictEqual(JSON.parse(fs.readFileSync(windowPayload.stateFile, 'utf8')).operationId, OPERATION_A);
  assert.strictEqual(
    commitUpdateOperationState(
      windowPayload.stateFile,
      null,
      { format: OPERATION_FORMAT, operationId: OPERATION_B, phase: 'installing' },
    ),
    true,
    'after the commit releases, the takeover must win serialization',
  );
  assert.strictEqual(JSON.parse(fs.readFileSync(windowPayload.stateFile, 'utf8')).operationId, OPERATION_B);
  fs.rmSync(windowRoot, { recursive: true, force: true });

  // Superseded helper after a Server takeover: B persists while A is between
  // commits; A's later publication must not overwrite B.
  const supersedeRoot = trackedRoot('farming-update-lock-supersede.');
  const supersedeCallsFile = path.join(supersedeRoot, 'npm-calls');
  const supersedeMarker = path.join(supersedeRoot, 'marker');
  const supersedePayload = payloadFor(supersedeRoot, {
    operationId: OPERATION_A,
    npmCommand: writeBlockingFakeNpm(supersedeRoot, supersedeMarker),
  });
  writePackage(supersedePayload.activePackageRoot, '2.2.5');
  writeCli(supersedePayload.activePackageRoot, 0, `${supersedeCallsFile}.starts`);
  seedOperation({ ...supersedePayload, operationId: OPERATION_A });
  const supersedeRun = runNpmUpdate(supersedePayload);
  // Body, release, settlement, and termination outcomes are captured
  // separately; the original body error always wins over cleanup failures.
  const supersedeOutcome: { body?: unknown; release?: unknown; settle?: unknown; terminate?: unknown } = {};
  try {
    await waitForFile(`${supersedeMarker}.waiting`);
    assert.strictEqual(
      commitUpdateOperationState(
        supersedePayload.stateFile,
        null,
        { format: OPERATION_FORMAT, operationId: OPERATION_B, method: 'npm', phase: 'installing', version: '2.4.0', previousVersion: '2.2.5' },
      ),
      true,
    );
  } catch (error) {
    supersedeOutcome.body = error;
  }
  try {
    // Always unblock the internal npm child so the run can settle before
    // cleanup removes the fixture.
    fs.writeFileSync(`${supersedeMarker}.release`, 'go');
  } catch (error) {
    supersedeOutcome.release = error;
  }
  try {
    await settleBounded(supersedeRun, 'the supersede helper run');
  } catch (error) {
    supersedeOutcome.settle = error;
  }
  try {
    await terminateBlockingFakeNpm(supersedeMarker);
  } catch (error) {
    supersedeOutcome.terminate = error;
  }
  const supersedeError = supersedeOutcome.body ?? supersedeOutcome.release ?? supersedeOutcome.settle ?? supersedeOutcome.terminate;
  if (supersedeError) throw supersedeError;
  const supersededFinal = JSON.parse(fs.readFileSync(supersedePayload.stateFile, 'utf8'));
  assert.strictEqual(supersededFinal.operationId, OPERATION_B, 'a superseded helper must not overwrite the takeover');
  assert.match(fs.readFileSync(supersedePayload.logPath, 'utf8'), /is no longer current/);
  fs.rmSync(supersedeRoot, { recursive: true, force: true });

  // Clear vs helper: removing the state file under the same claim supersedes
  // the blocked helper exactly like a new Server would.
  const clearRoot = trackedRoot('farming-update-lock-clear.');
  const clearCallsFile = path.join(clearRoot, 'npm-calls');
  const clearMarker = path.join(clearRoot, 'marker');
  const clearPayload = payloadFor(clearRoot, {
    operationId: OPERATION_A,
    npmCommand: writeBlockingFakeNpm(clearRoot, clearMarker),
  });
  writePackage(clearPayload.activePackageRoot, '2.2.5');
  writeCli(clearPayload.activePackageRoot, 0, `${clearCallsFile}.starts`);
  seedOperation({ ...clearPayload, operationId: OPERATION_A });
  const clearRun = runNpmUpdate(clearPayload);
  const clearOutcome: { body?: unknown; release?: unknown; settle?: unknown; terminate?: unknown } = {};
  try {
    await waitForFile(`${clearMarker}.waiting`);
    assert.strictEqual(removeUpdateOperationState(clearPayload.stateFile), true);
  } catch (error) {
    clearOutcome.body = error;
  }
  try {
    // Always unblock the internal npm child so the run can settle before
    // cleanup removes the fixture.
    fs.writeFileSync(`${clearMarker}.release`, 'go');
  } catch (error) {
    clearOutcome.release = error;
  }
  try {
    await settleBounded(clearRun, 'the clear helper run');
  } catch (error) {
    clearOutcome.settle = error;
  }
  try {
    await terminateBlockingFakeNpm(clearMarker);
  } catch (error) {
    clearOutcome.terminate = error;
  }
  const clearError = clearOutcome.body ?? clearOutcome.release ?? clearOutcome.settle ?? clearOutcome.terminate;
  if (clearError) throw clearError;
  assert.strictEqual(fs.existsSync(clearPayload.stateFile), false, 'a cleared state file must stay cleared');
  assert.match(fs.readFileSync(clearPayload.logPath, 'utf8'), /is no longer current/);
  fs.rmSync(clearRoot, { recursive: true, force: true });

  // Failure-path proof: an injected body failure while the internal fake npm
  // is blocked must surface the original body error first, and the blocked
  // child must be terminated with exact identity proof before the fixture is
  // removed — even when settlement times out first.
  const failpathRoot = trackedRoot('farming-update-lock-failpath.');
  const failpathCallsFile = path.join(failpathRoot, 'npm-calls');
  const failpathMarker = path.join(failpathRoot, 'marker');
  const failpathPayload = payloadFor(failpathRoot, {
    operationId: OPERATION_A,
    npmCommand: writeBlockingFakeNpm(failpathRoot, failpathMarker),
  });
  writePackage(failpathPayload.activePackageRoot, '2.2.5');
  writeCli(failpathPayload.activePackageRoot, 0, `${failpathCallsFile}.starts`);
  seedOperation({ ...failpathPayload, operationId: OPERATION_A });
  const failpathRun = runNpmUpdate(failpathPayload);
  const failpathOutcome: { body?: unknown; release?: unknown; settle?: unknown; terminate?: unknown } = {};
  const syntheticBodyError = new Error('synthetic scenario body failure');
  try {
    await waitForFile(`${failpathMarker}.waiting`);
    throw syntheticBodyError;
  } catch (error) {
    failpathOutcome.body = error;
  }
  // Capture the first child's identity while its marker is provably visible.
  const failpathFirstMarkerIdentity = JSON.parse(fs.readFileSync(`${failpathMarker}.waiting`, 'utf8'));
  try {
    // No release marker before settlement: the run stays blocked and the
    // bounded settlement must time out.
    await settleBounded(failpathRun, 'the fail-path helper run', 200);
  } catch (error) {
    failpathOutcome.settle = error;
  }
  try {
    await terminateBlockingFakeNpm(failpathMarker);
  } catch (error) {
    failpathOutcome.terminate = error;
  }
  try {
    // Unblock any continuation so the run can finish before fixture cleanup.
    fs.writeFileSync(`${failpathMarker}.release`, 'go');
  } catch (error) {
    failpathOutcome.release = error;
  }
  try {
    await settleBounded(failpathRun, 'the fail-path helper run after termination');
  } catch (error) {
    if (!failpathOutcome.settle) failpathOutcome.settle = error;
  }
  const failpathError = failpathOutcome.body ?? failpathOutcome.release ?? failpathOutcome.settle ?? failpathOutcome.terminate;
  assert.strictEqual(failpathError, syntheticBodyError, 'the original body error must win over release/settle/termination outcomes');
  assert(failpathOutcome.settle, 'the blocked run must have timed out settlement before termination');
  const failpathFirstIdentity = failpathFirstMarkerIdentity;
  assert.strictEqual(
    readServerProcessIdentity(failpathFirstIdentity.pid),
    null,
    'the blocked fake-npm child must be confirmed terminated by exact identity',
  );
  assert.strictEqual(
    fs.existsSync(`${failpathMarker}.claim-${failpathFirstIdentity.pid}`),
    false,
    'the first child\'s claim directory must be removed after termination proof',
  );
  // No live claim directory may remain, whatever the retry lifecycle did.
  if (fs.existsSync(`${failpathMarker}.waiting`)) {
    const failpathLeftoverIdentity = JSON.parse(fs.readFileSync(`${failpathMarker}.waiting`, 'utf8'));
    assert.strictEqual(
      fs.existsSync(`${failpathMarker}.claim-${failpathLeftoverIdentity.pid}`),
      false,
      'no leftover marker may keep a claim directory behind',
    );
  }

  // A marker whose expected identity no longer matches the current occupant
  // of that PID (reuse scenario) must never kill the unrelated process.
  const reuseRoot = trackedRoot('farming-update-lock-reuse.');
  const reuseMarker = path.join(reuseRoot, 'marker');
  const reuseChild = trackedChild(spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }));
  try {
    await new Promise((resolve, reject) => {
      reuseChild.once('spawn', resolve);
      reuseChild.once('error', reject);
    });
    const reuseIdentity = readServerProcessIdentity(reuseChild.pid);
    assert(reuseIdentity, 'reuse fixture must expose a process identity');
    fs.writeFileSync(`${reuseMarker}.waiting`, `${JSON.stringify({
      format: 'ps-lstart-c-utc-v1',
      pid: reuseChild.pid,
      processGroupId: reuseIdentity.processGroupId,
      startedAt: 'Sun Jan 1 00:00:00 2000',
    })}\n`);
    fs.mkdirSync(`${reuseMarker}.claim-${reuseChild.pid}`, { recursive: true });
    await terminateBlockingFakeNpm(reuseMarker);
    assert.strictEqual(
      isProcessRunning(reuseChild.pid),
      true,
      'an unrelated process occupying a reused PID must survive termination',
    );
    assert.strictEqual(
      fs.existsSync(`${reuseMarker}.claim-${reuseChild.pid}`),
      false,
      'the marker claim directory must be cleaned even when no kill happens',
    );
  } finally {
    // Exact cleanup of the tracked child even on assertion failure.
    await killChildBounded(reuseChild);
  }

  // A marker without its exclusive claim directory cannot prove its writer:
  // termination must fail visibly and never kill.
  const unownedMarkerRoot = trackedRoot('farming-update-lock-unowned.');
  const unownedMarkerBase = path.join(unownedMarkerRoot, 'marker');
  fs.writeFileSync(`${unownedMarkerBase}.waiting`, `${JSON.stringify({
    format: 'ps-lstart-c-utc-v1',
    pid: 424242,
    processGroupId: 424242,
    startedAt: 'Sun Jan 1 00:00:00 2000',
  })}\n`);
  await assert.rejects(
    async () => terminateBlockingFakeNpm(unownedMarkerBase),
    (error: Error) => /Cannot prove marker ownership/.test(error.message),
    'a marker without its claim directory must fail visibly instead of killing',
  );

  // Marker validation: unreadable markers and foreign formats fail visibly
  // instead of implying there is no child to terminate.
  const markerFailRoot = trackedRoot('farming-update-lock-markerfail.');
  const markerFailBase = path.join(markerFailRoot, 'marker');
  fs.mkdirSync(`${markerFailBase}.waiting`, { recursive: true });
  await assert.rejects(
    async () => terminateBlockingFakeNpm(markerFailBase),
    (error: Error) => /Cannot read the blocking fake-npm marker/.test(error.message),
    'an unreadable marker must fail visibly instead of implying no child',
  );
  fs.rmSync(`${markerFailBase}.waiting`, { recursive: true, force: true });
  fs.writeFileSync(`${markerFailBase}.waiting`, `${JSON.stringify({
    format: 'foreign-identity-format-v9',
    pid: 424242,
    processGroupId: 424242,
    startedAt: 'Sun Jan 1 00:00:00 2000',
  })}\n`);
  await assert.rejects(
    async () => terminateBlockingFakeNpm(markerFailBase),
    (error: Error) => /no valid process identity/.test(error.message),
    'a foreign marker format must fail visibly',
  );
  } catch (error) {
    b2BodyError = error;
    throw error;
  } finally {
    // Attempt every registered child and root even if one cleanup step fails:
    // record the first cleanup error and continue exact cleanup; it is
    // surfaced after the try/finally so a finally never throws.
    for (const child of b2Children) {
      try {
        await killChildBounded(child);
      } catch (error) {
        if (!b2CleanupError) b2CleanupError = error instanceof Error ? error : new Error(String(error));
      }
    }
    for (const root of b2FixtureRoots) {
      try {
        fs.rmSync(root, { recursive: true, force: true });
      } catch (error) {
        if (!b2CleanupError) b2CleanupError = error instanceof Error ? error : new Error(String(error));
      }
    }
  }
  // Never mask the original assertion error with a cleanup failure.
  if (b2CleanupError && b2BodyError === null) throw b2CleanupError;

  console.log('✓ npm update helper covers immutable activation, multi-instance restart, and rollback failover');
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
