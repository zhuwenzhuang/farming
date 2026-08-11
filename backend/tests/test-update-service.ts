const assert = require('assert');
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

type HttpServer = import('http').Server;

function serverPort(server: HttpServer): number {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('expected a TCP listener');
  return address.port;
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
    assert.deepStrictEqual(calls.at(-1), ['check', { force: true }]);

    const regularCheck = await fetch(baseUrl);
    assert.strictEqual(regularCheck.status, 200);
    assert.deepStrictEqual(calls.at(-1), ['check', { force: false }]);

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

  const npmSpawned = [];
  const packageInstallationsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-package-installations-'));
  const npmService = new FarmingUpdateService({
    rootDir: npmRoot,
    configDir: npmConfigDir,
    npmPackageRoot: npmRoot,
    packageInstallationsDir,
    platform: 'darwin',
    arch: 'arm64',
    fetchJson: async url => {
      assert.strictEqual(String(url), 'https://registry.npmjs.org/farming-code');
      return npmMetadata;
    },
    spawn: (command, args, options) => {
      const record = { command, args, options, unrefed: false };
      npmSpawned.push(record);
      return { unref() { record.unrefed = true; } };
    },
  });

  const npmStatus = await npmService.check({ force: true });
  assert.strictEqual(npmStatus.method, 'npm');
  assert.strictEqual(npmStatus.current.type, 'npm');
  assert.strictEqual(npmStatus.current.installDir, npmRoot);
  assert.strictEqual(npmStatus.latest.version, '2.3.0');
  assert.strictEqual(npmStatus.latest.source, 'https://registry.npmjs.org/farming-code');
  assert.strictEqual(npmStatus.target.proven, true);
  assert(npmStatus.target.installationRoot.startsWith(fs.realpathSync.native(packageInstallationsDir)));
  assert.strictEqual(npmStatus.target.activePackageRoot, fs.realpathSync.native(npmRoot));
  assert.deepStrictEqual(npmStatus.versions.map(version => version.version), ['2.3.0', '2.2.6', '2.2.5']);

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
