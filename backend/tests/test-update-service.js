const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  FarmingUpdateService,
  compareVersions,
  detectInstallMethod,
  normalizeVersion,
  npmPackageMetadataUrl,
  npmPackageRoot,
  npmVersionsFromMetadata,
} = require('../update-service');

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

  const serverSource = fs.readFileSync(path.join(process.cwd(), 'backend/server.js'), 'utf8');
  assert(serverSource.includes("app.get(routePath(BASE_PATH, '/api/update')"));
  assert(serverSource.includes("app.post(routePath(BASE_PATH, '/api/update/install')"));
  assert(serverSource.includes("app.post(routePath(BASE_PATH, '/api/update/restart')"));
  assert(!serverSource.includes('getUpdateUrl'));

  assert.strictEqual(normalizeVersion('v2.0.5'), '2.0.5');
  assert.strictEqual(compareVersions('2.0.5', '2.0.0'), 1);
  assert.strictEqual(compareVersions('2', '2.0.0'), 0);

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
      '2.2.5': { dist: { unpackedSize: 10 } },
      '2.2.6': { dist: { unpackedSize: 11 } },
      '2.3.0': { dist: { unpackedSize: 12 } },
      '2.4.0-beta.1': { dist: { unpackedSize: 13 } },
    },
  };
  assert.deepStrictEqual(
    npmVersionsFromMetadata(npmMetadata, '2.2.5').map(version => [version.version, version.available]),
    [['2.3.0', true], ['2.2.6', true], ['2.2.5', false]],
  );

  const npmSpawned = [];
  let resolvedNpmPrefix = '';
  const npmService = new FarmingUpdateService({
    rootDir: npmRoot,
    configDir: npmConfigDir,
    npmPackageRoot: npmRoot,
    platform: 'darwin',
    arch: 'arm64',
    fetchJson: async url => {
      assert.strictEqual(String(url), 'https://registry.npmjs.org/farming-code');
      return npmMetadata;
    },
    getNpmGlobalRoot: async (_npmCommand, prefix) => {
      resolvedNpmPrefix = prefix;
      return npmGlobalRoot;
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
  assert.strictEqual(npmStatus.target.npmPrefix, npmPrefix);
  assert.strictEqual(resolvedNpmPrefix, npmPrefix);
  assert.deepStrictEqual(npmStatus.versions.map(version => version.version), ['2.3.0', '2.2.6', '2.2.5']);

  const previousNodeBin = process.env.FARMING_NODE_BIN;
  const previousNpmCommand = process.env.FARMING_NPM_COMMAND;
  const previousNpmPrefix = process.env.FARMING_NPM_PREFIX;
  const previousNodeLd = process.env.FARMING_NODE_LD;
  const previousNodeLibraryPath = process.env.FARMING_NODE_LIBRARY_PATH;
  process.env.FARMING_NODE_BIN = '/opt/farming/runtime/bin/node';
  process.env.FARMING_NPM_COMMAND = '/opt/farming/runtime/bin/npm';
  process.env.FARMING_NPM_PREFIX = '/opt/farming/npm';
  process.env.FARMING_NODE_LD = '/opt/farming/glibc/lib/ld-linux-x86-64.so.2';
  process.env.FARMING_NODE_LIBRARY_PATH = '/opt/farming/glibc/lib';
  let npmInstallState;
  let npmApplyState;
  try {
    npmInstallState = await npmService.startInstall({ assetName: '2.2.6' });
    npmService.persistInstallState({
      ...npmInstallState,
      phase: 'ready-to-restart',
      preparedAt: new Date().toISOString(),
    });
    fs.mkdirSync(npmInstallState.stagingPackageRoot, { recursive: true });
    fs.writeFileSync(path.join(npmInstallState.stagingPackageRoot, 'package.json'), JSON.stringify({
      name: 'farming-code',
      version: '2.2.6',
    }));
    npmApplyState = await npmService.applyPreparedUpdate();
  } finally {
    if (previousNodeBin === undefined) delete process.env.FARMING_NODE_BIN;
    else process.env.FARMING_NODE_BIN = previousNodeBin;
    if (previousNpmCommand === undefined) delete process.env.FARMING_NPM_COMMAND;
    else process.env.FARMING_NPM_COMMAND = previousNpmCommand;
    if (previousNpmPrefix === undefined) delete process.env.FARMING_NPM_PREFIX;
    else process.env.FARMING_NPM_PREFIX = previousNpmPrefix;
    if (previousNodeLd === undefined) delete process.env.FARMING_NODE_LD;
    else process.env.FARMING_NODE_LD = previousNodeLd;
    if (previousNodeLibraryPath === undefined) delete process.env.FARMING_NODE_LIBRARY_PATH;
    else process.env.FARMING_NODE_LIBRARY_PATH = previousNodeLibraryPath;
  }

  assert.strictEqual(npmInstallState.phase, 'installing');
  assert.strictEqual(npmApplyState.phase, 'restarting');
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
  assert.strictEqual(npmUpdatePayload.targetVersion, '2.2.6');
  assert.strictEqual(npmUpdatePayload.previousVersion, '2.2.5');
  assert.strictEqual(npmUpdatePayload.action, 'prepare');
  assert.strictEqual(npmUpdatePayload.configDir, npmConfigDir);
  assert.strictEqual(npmUpdatePayload.npmCommand, '/opt/farming/runtime/bin/npm');
  assert.strictEqual(npmUpdatePayload.npmPrefix, npmPrefix);
  assert.strictEqual(npmUpdatePayload.packageRoot, npmRoot);
  assert(npmUpdatePayload.stagingPrefix.startsWith(path.join(npmConfigDir, 'updates', 'npm-2.2.6.')));
  assert.strictEqual(
    npmUpdatePayload.stagingPackageRoot,
    npmPackageRoot(path.join(npmUpdatePayload.stagingPrefix, 'lib', 'node_modules'), 'farming-code'),
  );
  assert.strictEqual(npmUpdatePayload.npmFallbackRegistryUrl, 'https://registry.npmjs.org');
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
  assert.strictEqual(migratedService.currentInstallState().phase, 'succeeded');

  const npmMismatchService = new FarmingUpdateService({
    rootDir: npmRoot,
    configDir: fs.mkdtempSync(path.join(os.tmpdir(), 'farming-npm-mismatch-config-')),
    npmPackageRoot: npmRoot,
    fetchJson: async () => npmMetadata,
    getNpmGlobalRoot: async () => path.join(os.tmpdir(), 'different-npm-root'),
    spawn: () => {
      throw new Error('npm update must not spawn when its target differs');
    },
  });
  const npmMismatchStatus = await npmMismatchService.check({ force: true });
  assert.strictEqual(npmMismatchStatus.available, false);
  assert.strictEqual(npmMismatchStatus.installable, false);
  assert.match(npmMismatchStatus.selected.blockedReason, /would target a different installation/);
  const npmMismatchInstall = await npmMismatchService.startInstall({ assetName: '2.2.6' });
  assert.strictEqual(npmMismatchInstall.phase, 'failed');

  const npmUnprovenService = new FarmingUpdateService({
    rootDir: npmRoot,
    configDir: fs.mkdtempSync(path.join(os.tmpdir(), 'farming-npm-unproven-config-')),
    fetchJson: async () => npmMetadata,
    getNpmGlobalRoot: async () => npmGlobalRoot,
  });
  const npmUnprovenStatus = await npmUnprovenService.check({ force: true });
  assert.strictEqual(npmUnprovenStatus.available, false);
  assert.strictEqual(npmUnprovenStatus.installable, false);
  assert.match(npmUnprovenStatus.selected.blockedReason, /has no managed package-root provenance/);

  console.log('✓ Farming in-app updates use npm only');
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
