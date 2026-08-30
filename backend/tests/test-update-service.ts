const assert = require('assert');
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const { createUpdateRouter } = require('../update-router.cjs');
const {
  FarmingUpdateService,
  compareVersions,
  detectInstallMethod,
  normalizeVersion,
  npmPackageMetadataUrl,
  npmPackageRoot,
  npmVersionsFromMetadata,
} = require('../update-service.cjs');
const {
  initializeCurrentPackageImage,
  publishPreparedPackageImage,
  publishRunningPackageImage,
} = require('../package-installation.cjs');
const {
  acquireUpdateStateLock,
  commitUpdateOperationState,
  releaseUpdateStateLock,
} = require('../update-operation-state.cjs');
const { readServerProcessIdentity } = require('../server-process-identity.cjs');

type HttpServer = import('http').Server;
type ChildProcess = import('child_process').ChildProcess;

function serverPort(server: HttpServer): number {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('expected a TCP listener');
  return address.port;
}

// Exact cleanup contract: attach the exit listener first, recheck state,
// send an exact SIGKILL, reject on timeout, and guarantee the postcondition
// "terminated". Fixture removal happens only after this resolves, so it can
// never race a dying process or proceed while a live child remains.
async function killChildConfirmed(child: ChildProcess): Promise<void> {
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

async function verifyUpdateRouterBehavior() {
  const calls: Array<[string, unknown?]> = [];
  let failure: { operation: 'check' | 'install' | 'restart'; message: string } | null = null;
  const service = {
    async check(options) {
      calls.push(['check', options]);
      if (failure?.operation === 'check') throw new Error(failure.message);
      return { available: true, checkedAt: '2026-08-08T00:00:00.000Z' };
    },
    async startInstall(options) {
      calls.push(['install', options]);
      if (failure?.operation === 'install') throw new Error(failure.message);
      return { phase: 'installing', version: options.assetName };
    },
    async applyPreparedUpdate() {
      calls.push(['restart']);
      if (failure?.operation === 'restart') throw new Error(failure.message);
      return { phase: 'restarting', version: '2.3.0' };
    },
  };
  const app = express();
  app.use((req, _res, next) => {
    req.authAccessMode = req.headers['x-test-access'] === 'read-only' ? 'read-only' : 'owner';
    next();
  });
  app.use('/api/update', createUpdateRouter(service));
  const server = await new Promise<HttpServer>(resolve => {
    const listener = app.listen(0, () => resolve(listener));
  });
  const baseUrl = `http://127.0.0.1:${serverPort(server)}/api/update`;

  try {
    const checked = await fetch(`${baseUrl}?force=1`);
    assert.strictEqual(checked.status, 200);
    assert.deepStrictEqual(await checked.json(), {
      update: { available: true, checkedAt: '2026-08-08T00:00:00.000Z' },
    });
    assert.deepStrictEqual(calls.at(-1), ['check', { force: true, observeOnly: false }]);

    const regularCheck = await fetch(baseUrl);
    assert.strictEqual(regularCheck.status, 200);
    assert.deepStrictEqual(calls.at(-1), ['check', { force: false, observeOnly: false }]);

    const readOnlyCheck = await fetch(`${baseUrl}?force=1`, {
      headers: { 'X-Test-Access': 'read-only' },
    });
    assert.strictEqual(readOnlyCheck.status, 200);
    assert.deepStrictEqual(calls.at(-1), ['check', { force: false, observeOnly: true }]);

    const install = await fetch(`${baseUrl}/install`, {
      body: JSON.stringify({ assetName: '2.3.0' }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });
    assert.strictEqual(install.status, 202);
    assert.deepStrictEqual(await install.json(), {
      update: { state: { phase: 'installing', version: '2.3.0' } },
    });
    assert.deepStrictEqual(calls.at(-1), ['install', { assetName: '2.3.0' }]);

    const invalidAssetName = await fetch(`${baseUrl}/install`, {
      body: JSON.stringify({ assetName: 23 }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });
    assert.strictEqual(invalidAssetName.status, 202);
    assert.deepStrictEqual(calls.at(-1), ['install', { assetName: '' }]);

    const restart = await fetch(`${baseUrl}/restart`, {
      body: '{}',
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });
    assert.strictEqual(restart.status, 202);
    assert.deepStrictEqual(await restart.json(), {
      update: { state: { phase: 'restarting', version: '2.3.0' } },
    });
    assert.deepStrictEqual(calls.at(-1), ['restart']);

    failure = { operation: 'check', message: 'registry unavailable' };
    const failedCheck = await fetch(baseUrl);
    assert.strictEqual(failedCheck.status, 502);
    assert.deepStrictEqual(await failedCheck.json(), { error: 'registry unavailable' });

    failure = { operation: 'check', message: '' };
    const fallbackCheck = await fetch(baseUrl);
    assert.strictEqual(fallbackCheck.status, 502);
    assert.deepStrictEqual(await fallbackCheck.json(), { error: 'Failed to check for updates' });

    failure = { operation: 'install', message: '' };
    const failedInstall = await fetch(`${baseUrl}/install`, {
      body: '{}',
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });
    assert.strictEqual(failedInstall.status, 500);
    assert.deepStrictEqual(await failedInstall.json(), { error: 'Failed to start update' });

    failure = { operation: 'restart', message: '' };
    const failedRestart = await fetch(`${baseUrl}/restart`, {
      body: '{}',
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });
    assert.strictEqual(failedRestart.status, 500);
    assert.deepStrictEqual(await failedRestart.json(), { error: 'Failed to restart for update' });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    });
  }
}

async function run() {
  const singleFlightRootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-update-single-flight-root-'));
  const singleFlightConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-update-single-flight-config-'));
  const singleFlightService = new FarmingUpdateService({
    rootDir: singleFlightRootDir,
    configDir: singleFlightConfigDir,
  });
  let singleFlightCalls = 0;
  let releaseSingleFlight;
  const singleFlightGate = new Promise((resolve) => {
    releaseSingleFlight = resolve;
  });
  singleFlightService.startInstallUnreserved = async () => {
    singleFlightCalls += 1;
    await singleFlightGate;
    return { phase: 'installing', version: 'single-flight' };
  };
  const firstSingleFlightStart = singleFlightService.startInstall();
  const secondSingleFlightStart = singleFlightService.startInstall();
  await Promise.resolve();
  assert.strictEqual(singleFlightCalls, 1, 'concurrent update starts should share one installer');
  releaseSingleFlight();
  assert.deepStrictEqual(await firstSingleFlightStart, { phase: 'installing', version: 'single-flight' });
  assert.deepStrictEqual(await secondSingleFlightStart, { phase: 'installing', version: 'single-flight' });
  assert.strictEqual(singleFlightService.installStartPromise, null, 'the start reservation should clear after completion');

  await verifyUpdateRouterBehavior();

  assert.strictEqual(normalizeVersion('v2.0.5'), '2.0.5');
  assert.strictEqual(compareVersions('2.0.5', '2.0.0'), 1);
  assert.strictEqual(compareVersions('2', '2.0.0'), 0);

  const restartRecoveryNow = Date.parse('2026-07-31T08:00:00.000Z');
  const reconcileRestartingState = (currentVersion, persistedState) => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-update-restart-recovery-root-'));
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-update-restart-recovery-config-'));
    try {
      fs.writeFileSync(path.join(rootDir, 'package.json'), JSON.stringify({
        name: 'farming-code',
        version: currentVersion,
      }));
      const stateFile = path.join(configDir, 'farming-update.json');
      fs.writeFileSync(stateFile, JSON.stringify(persistedState));
      const service = new FarmingUpdateService({
        rootDir,
        configDir,
        installMethod: 'npm',
        now: () => restartRecoveryNow,
      });
      const state = service.currentInstallState();
      return {
        state,
        persisted: fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : null,
      };
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
      fs.rmSync(configDir, { recursive: true, force: true });
    }
  };

  const completedRestart = reconcileRestartingState('2.2.30', {
    method: 'npm',
    phase: 'restarting',
    version: '2.2.30',
    restartingAt: '2026-07-31T07:59:30.000Z',
    error: 'stale helper error',
  });
  assert.strictEqual(completedRestart.state.phase, 'succeeded');
  assert.strictEqual(completedRestart.state.error, '');
  assert.strictEqual(completedRestart.state.completedAt, '2026-07-31T08:00:00.000Z');
  assert.deepStrictEqual(completedRestart.persisted, completedRestart.state);

  const supersededRestart = reconcileRestartingState('2.2.33', {
    method: 'npm',
    phase: 'restarting',
    version: '2.2.30',
    restartingAt: '2026-07-31T07:59:30.000Z',
  });
  assert.strictEqual(supersededRestart.state.phase, 'idle');
  assert.strictEqual(supersededRestart.persisted, null);

  const recentRestart = reconcileRestartingState('2.2.29', {
    method: 'npm',
    phase: 'restarting',
    version: '2.2.30',
    restartingAt: '2026-07-31T07:59:30.000Z',
  });
  assert.strictEqual(recentRestart.state.phase, 'restarting');
  assert.deepStrictEqual(recentRestart.persisted, recentRestart.state);

  const staleLegacyRestart = reconcileRestartingState('2.2.29', {
    method: 'npm',
    phase: 'restarting',
    version: '2.2.30',
    preparedAt: '2026-07-31T07:57:00.000Z',
    startedAt: '2026-07-31T07:56:00.000Z',
  });
  assert.strictEqual(staleLegacyRestart.state.phase, 'failed');
  assert.match(staleLegacyRestart.state.error, /did not restart into version 2\.2\.30 within 2 minutes; retry the update/i);
  assert.strictEqual(staleLegacyRestart.state.completedAt, '2026-07-31T08:00:00.000Z');
  assert.deepStrictEqual(staleLegacyRestart.persisted, staleLegacyRestart.state);

  const staleFailedOperation = reconcileRestartingState('2.2.34', {
    format: 'farming-update-operation-v1',
    operationId: '00000000-0000-4000-8000-000000000001',
    method: 'npm',
    phase: 'failed',
    version: '2.2.28',
    previousVersion: '2.2.27',
    completedAt: '2026-07-31T07:59:30.000Z',
    error: 'old update failure',
  });
  assert.strictEqual(staleFailedOperation.state.phase, 'idle');
  assert.strictEqual(staleFailedOperation.persisted, null);

  const recentFailedOperation = reconcileRestartingState('2.2.29', {
    format: 'farming-update-operation-v1',
    operationId: '00000000-0000-4000-8000-000000000002',
    method: 'npm',
    phase: 'failed',
    version: '2.2.30',
    previousVersion: '2.2.29',
    completedAt: '2026-07-31T07:59:30.000Z',
    error: 'current update failure',
  });
  assert.strictEqual(recentFailedOperation.state.phase, 'failed');
  assert.deepStrictEqual(recentFailedOperation.persisted, recentFailedOperation.state);

  const expiredSucceededOperation = reconcileRestartingState('2.2.30', {
    format: 'farming-update-operation-v1',
    operationId: '00000000-0000-4000-8000-000000000003',
    method: 'npm',
    phase: 'succeeded',
    version: '2.2.30',
    previousVersion: '2.2.29',
    completedAt: '2026-07-29T07:59:30.000Z',
  });
  assert.strictEqual(expiredSucceededOperation.state.phase, 'idle');
  assert.strictEqual(expiredSucceededOperation.persisted, null);

  const invalidActiveOperation = reconcileRestartingState('2.2.29', {
    format: 'farming-update-operation-v1',
    operationId: '00000000-0000-4000-8000-000000000004',
    method: 'npm',
    phase: 'installing',
    version: '2.2.30',
    previousVersion: '2.2.29',
  });
  assert.strictEqual(invalidActiveOperation.state.phase, 'idle');
  assert.strictEqual(invalidActiveOperation.persisted, null);

  const timeoutFenceNow = Date.parse('2026-07-31T08:00:00.000Z');
  const timeoutCases = [
    { phase: 'installing', currentVersion: '2.2.29', startedAt: '2026-07-31T07:29:59.000Z' },
    { phase: 'preparing-runtimes', currentVersion: '2.2.29', startedAt: '2026-07-31T07:29:59.000Z' },
    { phase: 'restarting', currentVersion: '2.2.29', startedAt: '2026-07-31T07:57:59.000Z' },
    { phase: 'rolling-back', currentVersion: '2.2.30', startedAt: '2026-07-31T07:57:59.000Z' },
  ];
  for (const [index, timeoutCase] of timeoutCases.entries()) {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), `farming-update-timeout-fence-root-${index}-`));
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), `farming-update-timeout-fence-config-${index}-`));
    try {
      fs.writeFileSync(path.join(rootDir, 'package.json'), JSON.stringify({
        name: 'farming-code',
        version: timeoutCase.currentVersion,
      }));
      const stateFile = path.join(configDir, 'farming-update.json');
      const operationId = `00000000-0000-4000-8000-0000000001${String(index).padStart(2, '0')}`;
      const originalState = {
        format: 'farming-update-operation-v1',
        operationId,
        method: 'npm',
        phase: timeoutCase.phase,
        version: '2.2.30',
        previousVersion: '2.2.29',
        startedAt: timeoutCase.startedAt,
        restartingAt: timeoutCase.phase === 'restarting' ? timeoutCase.startedAt : undefined,
      };
      fs.writeFileSync(stateFile, JSON.stringify(originalState));
      const service = new FarmingUpdateService({
        rootDir,
        configDir,
        installMethod: 'npm',
        now: () => timeoutFenceNow,
      });

      const timedOut = service.currentInstallState();
      assert.strictEqual(timedOut.phase, 'failed');
      assert.notStrictEqual(
        timedOut.operationId,
        operationId,
        `${timeoutCase.phase} timeout must revoke the detached helper operation identity`,
      );
      assert.strictEqual(timedOut.timedOutOperationId, operationId);
      assert.strictEqual(
        commitUpdateOperationState(
          stateFile,
          { format: 'farming-update-operation-v1', operationId },
          { ...originalState, phase: 'ready-to-restart' },
        ),
        false,
        `${timeoutCase.phase} detached helper must not publish after timeout`,
      );
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(stateFile, 'utf8')), timedOut);
      if (index === 0) {
        const progressedState = JSON.parse(JSON.stringify({
          ...originalState,
          phase: 'ready-to-restart',
        }));
        fs.writeFileSync(stateFile, JSON.stringify(progressedState));
        assert.deepStrictEqual(
          service.fenceTimedOutInstallState(originalState, 'stale timeout decision', true),
          progressedState,
          'a stale timeout decision must not replace a completed phase of the same operation',
        );
        assert.deepStrictEqual(JSON.parse(fs.readFileSync(stateFile, 'utf8')), progressedState);

        const replacementState = JSON.parse(JSON.stringify({
          ...originalState,
          operationId: '00000000-0000-4000-8000-0000000001ff',
          startedAt: '2026-07-31T07:59:00.000Z',
        }));
        fs.writeFileSync(stateFile, JSON.stringify(replacementState));
        assert.deepStrictEqual(
          service.fenceTimedOutInstallState(originalState, 'stale timeout decision', true),
          replacementState,
          'a stale timeout decision must reconcile the replacement instead of fencing it',
        );
        assert.deepStrictEqual(JSON.parse(fs.readFileSync(stateFile, 'utf8')), replacementState);
      }
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
      fs.rmSync(configDir, { recursive: true, force: true });
    }
  }

  const removedStateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-removed-update-root-'));
  const removedStateConfig = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-removed-update-config-'));
  fs.writeFileSync(path.join(removedStateRoot, 'package.json'), JSON.stringify({
    name: 'farming-code',
    version: '2.2.29',
  }));
  const removedStateService = new FarmingUpdateService({
    rootDir: removedStateRoot,
    configDir: removedStateConfig,
    installMethod: 'npm',
  });
  removedStateService.persistInstallState({
    method: 'npm',
    phase: 'failed',
    version: '2.2.30',
    previousVersion: '2.2.29',
    completedAt: new Date().toISOString(),
  });
  fs.rmSync(path.join(removedStateConfig, 'farming-update.json'));
  assert.strictEqual(removedStateService.currentInstallState().phase, 'idle');

  // Update-state lock failures must never desynchronize in-memory state from
  // disk, and clear must fail explicitly while another holder owns the claim.
  const lockRootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-update-lock-consistency-root-'));
  const lockConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-update-lock-consistency-config-'));
  try {
  fs.writeFileSync(path.join(lockRootDir, 'package.json'), JSON.stringify({
    name: 'farming-code',
    version: '2.2.29',
  }));
  const lockService = new FarmingUpdateService({
    rootDir: lockRootDir,
    configDir: lockConfigDir,
    installMethod: 'npm',
  });
  const lockStateFile = path.join(lockConfigDir, 'farming-update.json');
  lockService.persistInstallState({
    method: 'npm',
    phase: 'installing',
    version: '2.2.30',
    previousVersion: '2.2.29',
    startedAt: new Date().toISOString(),
  });
  const heldClaim = acquireUpdateStateLock(lockStateFile);
  try {
    const persistStart = Date.now();
    assert.throws(
      () => lockService.persistInstallState({
        method: 'npm',
        phase: 'ready-to-restart',
        version: '2.2.30',
        previousVersion: '2.2.29',
      }),
      (error: Error & { code?: string }) => /update state lock/i.test(error.message)
        && error.code === 'FARMING_UPDATE_STATE_LOCK',
      'a locked state file must fail the persist visibly',
    );
    assert(
      Date.now() - persistStart < 1000,
      'the Server must make a single non-waiting claim attempt, never poll',
    );
    assert.strictEqual(lockService.installState.phase, 'installing', 'memory must follow disk only after a committed write');
    assert.strictEqual(JSON.parse(fs.readFileSync(lockStateFile, 'utf8')).phase, 'installing');
    const clearStart = Date.now();
    assert.throws(
      () => lockService.clearInstallState(),
      (error: Error & { code?: string }) => /update state lock/i.test(error.message)
        && error.code === 'FARMING_UPDATE_STATE_LOCK',
      'clear must fail explicitly while the claim is held, not report idle',
    );
    assert(
      Date.now() - clearStart < 1000,
      'a contended clear must fail immediately without blocking the event loop',
    );
    assert.strictEqual(lockService.installState.phase, 'installing');
    assert(fs.existsSync(lockStateFile), 'a held claim must keep the state file untouched');
  } finally {
    assert.strictEqual(releaseUpdateStateLock(lockStateFile, heldClaim), true);
  }

  // A read-only Config clear is still tolerated: only filesystem permission
  // failures may fall back to the in-memory idle presentation.
  const originalRmSync = fs.rmSync;
  fs.rmSync = ((...rmArgs: Parameters<typeof originalRmSync>) => {
    const target = rmArgs[0];
    if (String(target) === lockStateFile) {
      const error = new Error(`EROFS: read-only file system, unlink '${target}'`) as NodeJS.ErrnoException;
      error.code = 'EROFS';
      throw error;
    }
    return originalRmSync(...rmArgs);
  }) as typeof originalRmSync;
  try {
    assert.strictEqual(lockService.clearInstallState().phase, 'idle');
  } finally {
    fs.rmSync = originalRmSync;
  }
  assert(fs.existsSync(lockStateFile), 'a read-only Config keeps its persisted state file');
  } finally {
    fs.rmSync(lockRootDir, { recursive: true, force: true });
    fs.rmSync(lockConfigDir, { recursive: true, force: true });
  }

  // Server crash recovery without any polling participant: the single
  // non-waiting attempt performs one exact synchronous reclaim of a
  // proven-dead helper claim, one immediate retry, and persists. Every
  // contended variant fails immediately without polling.
  const recoveryRootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-update-server-recovery-root-'));
  const recoveryConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-update-server-recovery-config-'));
  fs.writeFileSync(path.join(recoveryRootDir, 'package.json'), JSON.stringify({
    name: 'farming-code',
    version: '2.2.29',
  }));
  const recoveryService = new FarmingUpdateService({
    rootDir: recoveryRootDir,
    configDir: recoveryConfigDir,
    installMethod: 'npm',
  });
  const recoveryStateFile = path.join(recoveryConfigDir, 'farming-update.json');
  const recoveryLockDir = `${recoveryStateFile}.lock`;
  const deadHelper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  try {
    await new Promise((resolve, reject) => {
      deadHelper.once('spawn', resolve);
      deadHelper.once('error', reject);
    });
    const deadHelperIdentity = readServerProcessIdentity(deadHelper.pid);
    assert(deadHelperIdentity, 'recovery fixture must expose a process identity');
    deadHelper.kill('SIGKILL');
    await new Promise(resolve => deadHelper.once('exit', resolve));
    const deadHelperClaim = {
      format: 'farming-update-state-lock-v1',
      pid: deadHelperIdentity.pid,
      processGroupId: deadHelperIdentity.processGroupId,
      startedAt: deadHelperIdentity.startedAt,
      token: '00000000-0000-4000-8000-00000000dead-helper',
      createdAt: new Date().toISOString(),
    };
    const writeDeadClaim = () => {
      fs.mkdirSync(recoveryLockDir, { recursive: true });
      fs.writeFileSync(path.join(recoveryLockDir, 'owner.json'), `${JSON.stringify(deadHelperClaim, null, 2)}\n`);
    };

    // Proven-dead helper claim: recovered synchronously, persist succeeds.
    writeDeadClaim();
    const recoveryStart = Date.now();
    recoveryService.persistInstallState({
      method: 'npm',
      phase: 'installing',
      version: '2.2.30',
      previousVersion: '2.2.29',
      startedAt: new Date().toISOString(),
    });
    assert(Date.now() - recoveryStart < 1200, 'dead-claim recovery must stay inside the non-waiting attempt');
    assert.strictEqual(recoveryService.installState.phase, 'installing');
    assert.strictEqual(JSON.parse(fs.readFileSync(recoveryStateFile, 'utf8')).phase, 'installing');
    assert.strictEqual(fs.existsSync(recoveryLockDir), false, 'the recovered claim must be gone');

    // Unverifiable claim: immediate visible failure, no polling.
    fs.mkdirSync(recoveryLockDir, { recursive: true });
    fs.writeFileSync(path.join(recoveryLockDir, 'owner.json'), '{"format":"farming-update-state-lock-v1"}\n');
    const unverifiableStart = Date.now();
    assert.throws(
      () => recoveryService.persistInstallState({
        method: 'npm',
        phase: 'ready-to-restart',
        version: '2.2.30',
        previousVersion: '2.2.29',
      }),
      (error: Error & { code?: string }) => /unverifiable/.test(error.message)
        && error.code === 'FARMING_UPDATE_STATE_LOCK',
      'an unverifiable claim must fail the Server immediately',
    );
    assert(Date.now() - unverifiableStart < 1000);
    assert.strictEqual(recoveryService.installState.phase, 'installing');
    fs.rmSync(recoveryLockDir, { recursive: true, force: true });

    // Crashed reclaim marker: immediate visible failure, claim untouched.
    writeDeadClaim();
    fs.mkdirSync(path.join(
      recoveryLockDir,
      `.reclaim-${crypto.createHash('sha256').update(deadHelperClaim.token).digest('hex')}`,
    ), { recursive: true });
    const crashedMarkerStart = Date.now();
    assert.throws(
      () => recoveryService.persistInstallState({
        method: 'npm',
        phase: 'ready-to-restart',
        version: '2.2.30',
        previousVersion: '2.2.29',
      }),
      (error: Error & { code?: string }) => /could not be recovered without waiting/.test(error.message)
        && error.code === 'FARMING_UPDATE_STATE_LOCK',
      'a crashed reclaim marker must fail the Server immediately',
    );
    assert(Date.now() - crashedMarkerStart < 1000);
    assert(fs.existsSync(path.join(recoveryLockDir, 'owner.json')), 'the dead claim must survive the failed recovery');
    fs.rmSync(recoveryLockDir, { recursive: true, force: true });

    // Reclaim rename failure: immediate visible failure, claim untouched.
    writeDeadClaim();
    const originalRenameSync = fs.renameSync;
    fs.renameSync = (...renameArgs) => {
      if (String(renameArgs[0]) === recoveryLockDir) {
        const error = new Error(`EACCES: permission denied, rename '${renameArgs[0]}'`) as NodeJS.ErrnoException;
        error.code = 'EACCES';
        throw error;
      }
      return originalRenameSync(...renameArgs);
    };
    try {
      const reclaimFailureStart = Date.now();
      assert.throws(
        () => recoveryService.persistInstallState({
          method: 'npm',
          phase: 'ready-to-restart',
          version: '2.2.30',
          previousVersion: '2.2.29',
        }),
        (error: Error & { code?: string }) => /could not be recovered without waiting/.test(error.message)
          && error.code === 'FARMING_UPDATE_STATE_LOCK',
        'a failed reclaim must fail the Server immediately',
      );
      assert(Date.now() - reclaimFailureStart < 1000);
    } finally {
      fs.renameSync = originalRenameSync;
    }
    assert(fs.existsSync(path.join(recoveryLockDir, 'owner.json')), 'the dead claim must survive the failed reclaim');
  } finally {
    await killChildConfirmed(deadHelper);
    fs.rmSync(recoveryRootDir, { recursive: true, force: true });
    fs.rmSync(recoveryConfigDir, { recursive: true, force: true });
  }

  for (const installMethod of ['app-bundle', 'source-deploy', 'source', 'standalone-cli']) {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), `farming-${installMethod}-update-root-`));
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), `farming-${installMethod}-update-config-`));
    fs.writeFileSync(path.join(rootDir, 'package.json'), JSON.stringify({
      name: 'farming-code',
      version: '2.2.5',
    }));
    let externalCalls = 0;
    const service = new FarmingUpdateService({
      rootDir,
      configDir,
      installMethod,
      manifestUrl: 'https://github.com/example/farming/releases/latest',
      fetchJson: async () => {
        externalCalls += 1;
        throw new Error('non-npm update must not fetch');
      },
      fetchText: async () => {
        externalCalls += 1;
        throw new Error('non-npm update must not fetch');
      },
      spawn: () => {
        externalCalls += 1;
        throw new Error('non-npm update must not spawn');
      },
    });

    const status = await service.check({ force: true });
    assert.strictEqual(status.method, installMethod);
    assert.strictEqual(status.available, false);
    assert.strictEqual(status.installable, false);
    assert.strictEqual(status.latest.source, '');
    await assert.rejects(service.startInstall(), /update|reinstall/i);
    await assert.rejects(service.applyPreparedUpdate(), /update|reinstall/i);
    assert.strictEqual(externalCalls, 0, `${installMethod} must not access an update source`);
  }

  const npmPrefix = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-npm-update-prefix-'));
  const npmGlobalRoot = path.join(npmPrefix, 'lib', 'node_modules');
  const npmRoot = path.join(npmGlobalRoot, 'farming-code');
  const npmConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-npm-update-config-'));
  fs.mkdirSync(path.join(npmRoot, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(npmRoot, 'package.json'), JSON.stringify({
    name: 'farming-code',
    version: '2.2.5',
  }));
  fs.writeFileSync(path.join(npmRoot, 'bin', 'farming'), '#!/usr/bin/env node\n');
  assert.strictEqual(detectInstallMethod(npmRoot), 'npm');
  fs.mkdirSync(path.join(npmRoot, '.git'));
  assert.strictEqual(detectInstallMethod(npmRoot), 'source');
  fs.rmSync(path.join(npmRoot, '.git'), { recursive: true, force: true });
  fs.writeFileSync(path.join(npmRoot, 'RELEASE.json'), JSON.stringify({
    type: 'app-bundle',
    updateMethod: 'npm',
    releaseVersion: '2.2.5',
  }));
  assert.strictEqual(detectInstallMethod(npmRoot), 'npm');
  fs.rmSync(path.join(npmRoot, 'RELEASE.json'));

  assert.strictEqual(
    npmPackageMetadataUrl('https://registry.npmjs.org/', 'farming-code'),
    'https://registry.npmjs.org/farming-code',
  );
  const npmMetadata = {
    'dist-tags': { latest: '2.3.0' },
    versions: {
      '2.2.5': { dist: { integrity: 'sha512-225', unpackedSize: 10 } },
      '2.2.6': { dist: { integrity: 'sha512-226', unpackedSize: 11 } },
      '2.3.0': { dist: { integrity: 'sha512-230', unpackedSize: 12 } },
      '2.4.0-beta.1': { dist: { integrity: 'sha512-beta', unpackedSize: 13 } },
    },
  };
  assert.deepStrictEqual(
    npmVersionsFromMetadata(npmMetadata, '2.2.5').map(version => [version.version, version.available]),
    [['2.3.0', true], ['2.2.6', true], ['2.2.5', false]],
  );
  assert.deepStrictEqual(
    npmVersionsFromMetadata(npmMetadata, '2.2.6').map(version => [version.version, version.available]),
    [['2.3.0', true], ['2.2.6', false]],
  );

  let npmFetchCalls = 0;
  const npmSpawned: Array<{
    command: string;
    args: readonly string[];
    options: import('child_process').SpawnOptions;
    unrefed: boolean;
    errorListener: ((error: Error) => void) | null;
  }> = [];
  const packageInstallationsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-package-installations-'));
  const npmService = new FarmingUpdateService({
    rootDir: npmRoot,
    configDir: npmConfigDir,
    npmPackageRoot: npmRoot,
    packageInstallationsDir,
    platform: 'darwin',
    arch: 'arm64',
    fetchJson: async url => {
      npmFetchCalls += 1;
      assert.strictEqual(String(url), 'https://registry.npmjs.org/farming-code');
      return npmMetadata;
    },
    spawn: (command, args, options) => {
      const record: (typeof npmSpawned)[number] = {
        command,
        args,
        options,
        unrefed: false,
        errorListener: null,
      };
      npmSpawned.push(record);
      return {
        once(event, listener) {
          if (event === 'error') record.errorListener = listener;
        },
        unref() { record.unrefed = true; },
      };
    },
  });

  await npmService.npmMetadata({ force: true });
  assert.strictEqual(npmFetchCalls, 1);
  const observeOnlyStateFile = path.join(npmConfigDir, 'farming-update.json');
  fs.writeFileSync(observeOnlyStateFile, JSON.stringify({
    format: 'farming-update-operation-v1',
    operationId: '00000000-0000-4000-8000-000000000099',
    method: 'npm',
    phase: 'restarting',
    version: '2.2.5',
    previousVersion: '2.2.4',
    restartingAt: '2026-08-08T00:00:00.000Z',
  }));
  const observeOnlyStateBytes = fs.readFileSync(observeOnlyStateFile);
  const observedNpmStatus = await npmService.check({ force: true, observeOnly: true });
  assert.strictEqual(npmFetchCalls, 1, 'a read-only update observation must ignore force and reuse fresh metadata');
  assert.strictEqual(observedNpmStatus.state.phase, 'succeeded');
  assert.deepStrictEqual(
    fs.readFileSync(observeOnlyStateFile),
    observeOnlyStateBytes,
    'a read-only update observation must not reconcile the persisted operation',
  );
  assert.strictEqual(
    fs.existsSync(npmService.packageInstallation.versionsDir),
    false,
    'a read-only update observation must not prepare the immutable installation directories',
  );
  assert.strictEqual(fs.existsSync(npmService.packageInstallation.stagingDir), false);
  assert.strictEqual(fs.existsSync(npmService.packageInstallation.usageDir), false);

  const npmStatus = await npmService.check({ force: true });
  assert.strictEqual(npmFetchCalls, 2, 'an Owner forced update check must refresh metadata');
  assert.strictEqual(npmStatus.method, 'npm');
  assert.strictEqual(npmStatus.current.type, 'npm');
  assert.strictEqual(npmStatus.current.installDir, npmRoot);
  assert.strictEqual(npmStatus.latest.version, '2.3.0');
  assert.strictEqual(npmStatus.latest.source, 'https://registry.npmjs.org/farming-code');
  assert.strictEqual(npmStatus.target.proven, true);
  assert(npmStatus.target.installationRoot.startsWith(fs.realpathSync.native(packageInstallationsDir)));
  assert.strictEqual(npmStatus.target.activePackageRoot, fs.realpathSync.native(npmRoot));
  assert.deepStrictEqual(npmStatus.versions.map(version => version.version), ['2.3.0', '2.2.6', '2.2.5']);
  assert.strictEqual(JSON.parse(fs.readFileSync(observeOnlyStateFile, 'utf8')).phase, 'succeeded');
  assert.strictEqual(fs.existsSync(npmService.packageInstallation.versionsDir), true);
  assert.strictEqual(fs.existsSync(npmService.packageInstallation.stagingDir), true);
  assert.strictEqual(fs.existsSync(npmService.packageInstallation.usageDir), true);

  const newerNpmPrefix = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-newer-npm-update-prefix-'));
  const newerNpmRoot = path.join(newerNpmPrefix, 'lib', 'node_modules', 'farming-code');
  fs.mkdirSync(path.join(newerNpmRoot, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(newerNpmRoot, 'package.json'), JSON.stringify({
    name: 'farming-code',
    version: '2.4.0',
  }));
  fs.writeFileSync(path.join(newerNpmRoot, 'bin', 'farming'), '#!/usr/bin/env node\n');
  const newerNpmService = new FarmingUpdateService({
    rootDir: newerNpmRoot,
    configDir: fs.mkdtempSync(path.join(os.tmpdir(), 'farming-newer-npm-update-config-')),
    npmPackageRoot: newerNpmRoot,
    packageInstallationsDir,
    fetchJson: async () => npmMetadata,
  });
  const newerNpmStatus = await newerNpmService.check({ force: true });
  assert.strictEqual(newerNpmStatus.current.packageVersion, '2.4.0');
  assert.strictEqual(newerNpmStatus.latest.version, '2.4.0');
  assert.deepStrictEqual(newerNpmStatus.versions, []);
  assert.strictEqual(newerNpmStatus.selected.version, '');
  assert.strictEqual(newerNpmStatus.available, false);
  assert.strictEqual(newerNpmStatus.installable, false);

  const previousNodeBin = process.env.FARMING_NODE_BIN;
  const previousNpmCommand = process.env.FARMING_NPM_COMMAND;
  const previousNodeLd = process.env.FARMING_NODE_LD;
  const previousNodeLibraryPath = process.env.FARMING_NODE_LIBRARY_PATH;
  process.env.FARMING_NODE_BIN = '/opt/farming/runtime/bin/node';
  process.env.FARMING_NPM_COMMAND = '/opt/farming/runtime/bin/npm';
  process.env.FARMING_NODE_LD = '/opt/farming/glibc/lib/ld-linux-x86-64.so.2';
  process.env.FARMING_NODE_LIBRARY_PATH = '/opt/farming/glibc/lib';
  let npmInstallState;
  let npmApplyState;
  let runningImage;
  let targetImage;
  try {
    npmInstallState = await npmService.startInstall({ assetName: '2.2.6' });
    const prepareTimeoutFence = npmService.persistInstallState({
      ...npmInstallState,
      operationId: '00000000-0000-4000-8000-0000000002f0',
      timedOutOperationId: npmInstallState.operationId,
      phase: 'failed',
      error: 'prepare timed out',
      completedAt: new Date().toISOString(),
    });
    npmSpawned[0].errorListener?.(new Error('late detached prepare spawn error'));
    assert.deepStrictEqual(
      JSON.parse(fs.readFileSync(path.join(npmConfigDir, 'farming-update.json'), 'utf8')),
      prepareTimeoutFence,
      'a late prepare spawn callback must not overwrite a timeout fence',
    );
    npmService.persistInstallState(npmInstallState);
    runningImage = publishRunningPackageImage(npmService.packageInstallation, npmRoot);
    const currentPointer = initializeCurrentPackageImage(npmService.packageInstallation, runningImage);
    fs.mkdirSync(npmInstallState.stagingPackageRoot, { recursive: true });
    fs.writeFileSync(path.join(npmInstallState.stagingPackageRoot, 'package.json'), JSON.stringify({
      name: 'farming-code',
      version: '2.2.6',
    }));
    targetImage = publishPreparedPackageImage(
      npmService.packageInstallation,
      npmInstallState.stagingPackageRoot,
      '2.2.6',
      'sha512-226',
    );
    npmService.persistInstallState({
      ...npmInstallState,
      phase: 'ready-to-restart',
      preparedAt: new Date().toISOString(),
      runningPackageRoot: runningImage.packageRoot,
      runningImageId: runningImage.imageId,
      targetPackageRoot: targetImage.packageRoot,
      targetImageId: targetImage.imageId,
      expectedCurrentImageId: currentPointer.imageId,
    });
    const persistedPreparedState = JSON.parse(fs.readFileSync(path.join(npmConfigDir, 'farming-update.json'), 'utf8'));
    assert.strictEqual(persistedPreparedState.format, 'farming-update-operation-v1');
    assert.strictEqual(persistedPreparedState.operationId, npmInstallState.operationId);
    npmApplyState = await npmService.applyPreparedUpdate();
    const applyTimeoutFence = npmService.persistInstallState({
      ...npmApplyState,
      operationId: '00000000-0000-4000-8000-0000000002f1',
      timedOutOperationId: npmApplyState.operationId,
      phase: 'failed',
      error: 'restart timed out',
      completedAt: new Date().toISOString(),
    });
    npmSpawned[1].errorListener?.(new Error('late detached apply spawn error'));
    assert.deepStrictEqual(
      JSON.parse(fs.readFileSync(path.join(npmConfigDir, 'farming-update.json'), 'utf8')),
      applyTimeoutFence,
      'a late apply spawn callback must not overwrite a timeout fence',
    );
    npmService.persistInstallState(npmApplyState);
  } finally {
    if (previousNodeBin === undefined) delete process.env.FARMING_NODE_BIN;
    else process.env.FARMING_NODE_BIN = previousNodeBin;
    if (previousNpmCommand === undefined) delete process.env.FARMING_NPM_COMMAND;
    else process.env.FARMING_NPM_COMMAND = previousNpmCommand;
    if (previousNodeLd === undefined) delete process.env.FARMING_NODE_LD;
    else process.env.FARMING_NODE_LD = previousNodeLd;
    if (previousNodeLibraryPath === undefined) delete process.env.FARMING_NODE_LIBRARY_PATH;
    else process.env.FARMING_NODE_LIBRARY_PATH = previousNodeLibraryPath;
  }

  assert.strictEqual(npmInstallState.phase, 'installing');
  assert.strictEqual(npmApplyState.phase, 'restarting');
  assert.match(npmApplyState.restartingAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.strictEqual(npmSpawned.length, 2);
  assert(npmSpawned.every(record => record.options.detached === true));
  assert(npmSpawned.every(record => record.options.stdio === 'ignore'));
  assert(npmSpawned.every(record => record.unrefed === true));
  assert.strictEqual(npmSpawned[0].command, '/opt/farming/glibc/lib/ld-linux-x86-64.so.2');
  assert.deepStrictEqual(npmSpawned[0].args.slice(0, 3), [
    '--library-path',
    '/opt/farming/glibc/lib',
    '/opt/farming/runtime/bin/node',
  ]);
  assert(npmSpawned[0].args[3].endsWith('/backend/npm-update-helper.cjs'));
  const npmUpdatePayload = JSON.parse(npmSpawned[0].options.env.FARMING_NPM_UPDATE_PAYLOAD);
  assert.match(npmUpdatePayload.operationId, /^[0-9a-f-]{16,64}$/i);
  assert.strictEqual(npmUpdatePayload.targetVersion, '2.2.6');
  assert.strictEqual(npmUpdatePayload.previousVersion, '2.2.5');
  assert.strictEqual(npmUpdatePayload.action, 'prepare');
  assert.strictEqual(npmUpdatePayload.configDir, npmConfigDir);
  assert.strictEqual(npmUpdatePayload.npmCommand, '/opt/farming/runtime/bin/npm');
  assert.strictEqual(npmUpdatePayload.activePackageRoot, fs.realpathSync.native(npmRoot));
  assert(npmUpdatePayload.stagingPrefix.startsWith(path.join(npmUpdatePayload.installationRoot, 'staging', 'npm-2.2.6.')));
  assert.strictEqual(
    npmUpdatePayload.stagingPackageRoot,
    npmPackageRoot(path.join(npmUpdatePayload.stagingPrefix, 'lib', 'node_modules'), 'farming-code'),
  );
  assert.strictEqual(npmUpdatePayload.npmFallbackRegistryUrl, 'https://registry.npmjs.org');
  const npmApplyPayload = JSON.parse(npmSpawned[1].options.env.FARMING_NPM_UPDATE_PAYLOAD);
  assert.strictEqual(npmApplyPayload.operationId, npmUpdatePayload.operationId);
  assert.strictEqual(npmApplyPayload.action, 'apply');
  assert.strictEqual(npmApplyPayload.restartingAt, npmApplyState.restartingAt);
  assert.strictEqual(npmApplyPayload.targetImageId, targetImage.imageId);
  assert.strictEqual(npmApplyPayload.runningImageId, runningImage.imageId);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(npmConfigDir, 'farming-update.json'), 'utf8')).phase, 'restarting');

  const migratedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-migrated-update-root-'));
  const migratedConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-migrated-update-config-'));
  fs.writeFileSync(path.join(migratedRoot, 'package.json'), JSON.stringify({
    name: 'farming-code',
    version: '2.3.0',
  }));
  fs.writeFileSync(path.join(migratedRoot, 'RELEASE.json'), JSON.stringify({
    type: 'app-bundle',
    updateMethod: 'npm',
    releaseVersion: '2.3.0',
    packageVersion: '2.3.0',
  }));
  fs.writeFileSync(path.join(migratedConfigDir, 'farming-update.json'), JSON.stringify({
    method: 'source-deploy',
    targetMethod: 'npm',
    phase: 'succeeded',
    version: '2.3.0',
  }));
  const migratedService = new FarmingUpdateService({
    rootDir: migratedRoot,
    configDir: migratedConfigDir,
  });
  assert.strictEqual(migratedService.currentInstallState().phase, 'idle');
  assert.strictEqual(fs.existsSync(path.join(migratedConfigDir, 'farming-update.json')), false);

  const npmMismatchService = new FarmingUpdateService({
    rootDir: npmRoot,
    configDir: fs.mkdtempSync(path.join(os.tmpdir(), 'farming-npm-mismatch-config-')),
    npmPackageRoot: path.join(npmPrefix, 'different-active-root'),
    packageInstallationContext: npmService.packageInstallation,
    fetchJson: async () => npmMetadata,
    spawn: () => {
      throw new Error('npm update must not spawn when its target differs');
    },
  });
  const npmMismatchStatus = await npmMismatchService.check({ force: true });
  assert.strictEqual(npmMismatchStatus.available, false);
  assert.strictEqual(npmMismatchStatus.installable, false);
  assert.match(npmMismatchStatus.selected.blockedReason, /does not match the active immutable package identity/);
  const npmMismatchInstall = await npmMismatchService.startInstall({ assetName: '2.2.6' });
  assert.strictEqual(npmMismatchInstall.phase, 'failed');

  const npmUnprovenService = new FarmingUpdateService({
    rootDir: npmRoot,
    configDir: fs.mkdtempSync(path.join(os.tmpdir(), 'farming-npm-unproven-config-')),
    npmPackageRoot: path.join(npmPrefix, 'unmanaged-root'),
    fetchJson: async () => npmMetadata,
  });
  const npmUnprovenStatus = await npmUnprovenService.check({ force: true });
  assert.strictEqual(npmUnprovenStatus.available, false);
  assert.strictEqual(npmUnprovenStatus.installable, false);
  assert.match(npmUnprovenStatus.selected.blockedReason, /has no managed installation identity/);

  console.log('✓ Farming in-app updates use npm only');
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
