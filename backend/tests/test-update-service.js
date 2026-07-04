const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  FarmingUpdateService,
  compareVersions,
  normalizeVersion,
  releaseInstallDir,
  releaseHasBundledGlibc,
  releaseFromManifest,
  manifestAssetSafety,
  selectManifestAsset,
  selectReleaseAsset,
} = require('../update-service');

async function run() {
  const serverSource = fs.readFileSync(path.join(process.cwd(), 'backend/server.js'), 'utf8');
  assert(serverSource.includes("app.get(routePath(BASE_PATH, '/api/update')"));
  assert(serverSource.includes("app.post(routePath(BASE_PATH, '/api/update/install')"));
  assert(serverSource.includes('Cannot upgrade while non-recoverable project agents are running'));
  assert(serverSource.includes("const { isRestartBlockingAgent } = require('./agent-activity');"));
  assert(serverSource.includes('.filter(isRestartBlockingAgent)'));

  assert.strictEqual(normalizeVersion('v2.0.5'), '2.0.5');
  assert.strictEqual(normalizeVersion('farming-2.tar.gz'), '2');
  assert.strictEqual(compareVersions('2.0.5', '2.0.0'), 1);
  assert.strictEqual(compareVersions('2', '2.0.0'), 0);

  const selected = selectReleaseAsset({
    assets: [
      { name: 'farming-2.tar.gz.sha256', browser_download_url: 'https://example.invalid/sha' },
      { name: 'farming_2_checksums.txt', browser_download_url: 'https://example.invalid/checksums' },
      { name: 'farming-2.tar.gz', browser_download_url: 'https://example.invalid/farming-2.tar.gz', size: 123 },
    ],
  });
  assert.strictEqual(selected.name, 'farming-2.tar.gz');
  const manifestAsset = selectManifestAsset({
    assets: [
      { name: 'farming-2.tar.gz', browser_download_url: 'https://example.invalid/farming-2.tar.gz' },
      { name: 'manifest.json', browser_download_url: 'https://example.invalid/manifest.json' },
    ],
  });
  assert.strictEqual(manifestAsset.name, 'manifest.json');
  assert.deepStrictEqual(
    manifestAssetSafety(selected, { assets: [{ file: 'farming-2.tar.gz', type: 'app-bundle', bundledGlibc: true }] }),
    { safe: true, bundledGlibc: true, reason: '' },
  );
  assert.strictEqual(
    manifestAssetSafety(selected, { assets: [{ file: 'farming-2.tar.gz', type: 'app-bundle', bundledGlibc: false }] }).safe,
    false,
  );
  assert.deepStrictEqual(
    manifestAssetSafety(selected, { assets: [{ file: 'farming-2.tar.gz', type: 'app-bundle' }] }),
    { safe: true, bundledGlibc: null, reason: '' },
    'older public manifests without bundledGlibc should still allow install-time bundle verification'
  );
  const publicManifestRelease = releaseFromManifest({
    releaseVersion: '2.0.5',
    tag: 'v2.0.5',
    assets: [
      { type: 'app-bundle', file: 'farming-2.0.5.tar.gz', bundledGlibc: true, sha256: 'abc' },
    ],
  }, { manifestUrl: 'https://updates.example.test/farming/manifest.json' });
  assert.strictEqual(publicManifestRelease.tag_name, 'v2.0.5');
  assert.strictEqual(publicManifestRelease.assets[0].name, 'farming-2.0.5.tar.gz');
  assert.strictEqual(publicManifestRelease.assets[0].sha256, 'abc');
  assert.strictEqual(
    publicManifestRelease.assets[0].browser_download_url,
    'https://updates.example.test/farming/farming-2.0.5.tar.gz'
  );
  const absoluteManifestRelease = releaseFromManifest({
    releaseVersion: '2.0.6',
    assets: [
      { type: 'app-bundle', file: 'farming-2.0.6.tar.gz', url: 'https://cdn.example.test/farming-2.0.6.tar.gz' },
    ],
  }, { manifestUrl: 'https://updates.example.test/farming/manifest.json' });
  assert.strictEqual(absoluteManifestRelease.assets[0].browser_download_url, 'https://cdn.example.test/farming-2.0.6.tar.gz');
  const simpleManifestRelease = releaseFromManifest({
    version: '2.0.7',
    tarUrl: 'farming-2.0.7.tar.gz',
    bundledGlibc: true,
  }, { manifestUrl: 'https://updates.example.test/farming/manifest.json' });
  assert.strictEqual(simpleManifestRelease.tag_name, 'v2.0.7');
  assert.strictEqual(simpleManifestRelease.assets[0].name, 'farming-2.0.7.tar.gz');
  assert.strictEqual(simpleManifestRelease.assets[0].browser_download_url, 'https://updates.example.test/farming/farming-2.0.7.tar.gz');
  assert.strictEqual(
    manifestAssetSafety(simpleManifestRelease.assets[0], {
      version: '2.0.7',
      tarUrl: 'farming-2.0.7.tar.gz',
      bundledGlibc: true,
    }).safe,
    true
  );

  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-update-root.'));
  fs.writeFileSync(path.join(rootDir, 'package.json'), JSON.stringify({ version: '2.0.0' }));
  fs.writeFileSync(path.join(rootDir, '.farming.pid'), '12345\n');
  assert.strictEqual(releaseInstallDir(rootDir), rootDir);

  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-update-config.'));
  const requestedUrls = [];
  const downloadedUrls = [];
  const spawned = [];
  const release205 = {
    tag_name: 'v2.0.5',
    name: 'Farming 2.0.5',
    published_at: '2026-07-01T00:00:00Z',
    assets: [
      { name: 'farming-2.0.5.tar.gz', browser_download_url: 'https://example.invalid/farming-2.0.5.tar.gz', size: 1024 },
      { name: 'manifest.json', browser_download_url: 'https://example.invalid/manifest.json', size: 512 },
    ],
  };
  const unconfiguredService = new FarmingUpdateService({
    rootDir,
    configDir,
    fetchJson: async () => {
      throw new Error('unconfigured update service must not fetch');
    },
  });
  const unconfiguredStatus = await unconfiguredService.check({ force: true });
  assert.strictEqual(unconfiguredStatus.available, false);
  assert.strictEqual(unconfiguredStatus.installable, false);
  assert.match(unconfiguredStatus.latest.blockedReason, /not configured/);
  assert.strictEqual(unconfiguredStatus.latest.source, '');

  const service = new FarmingUpdateService({
    rootDir,
    configDir,
    manifestUrl: 'https://updates.example.test/farming/manifest.json',
    fetchJson: async (url) => {
      requestedUrls.push(String(url));
      if (String(url).endsWith('/manifest.json')) {
        return {
          releaseVersion: '2.0.5',
          tag: 'v2.0.5',
          assets: [
            { type: 'app-bundle', file: 'farming-2.0.5.tar.gz', bundledGlibc: true },
          ],
        };
      }
      return release205;
    },
    downloadFile: async (url, outputPath) => {
      downloadedUrls.push(String(url));
      fs.writeFileSync(outputPath, 'archive');
    },
    execFile: (_command, args, callback) => {
      const extractRoot = args[args.indexOf('-C') + 1];
      const releaseDir = path.join(extractRoot, 'farming-2.0.5');
      fs.mkdirSync(path.join(releaseDir, 'scripts'), { recursive: true });
      fs.mkdirSync(path.join(releaseDir, 'vendor'), { recursive: true });
      fs.writeFileSync(path.join(releaseDir, 'RELEASE.json'), JSON.stringify({ bundledGlibc: true }));
      fs.writeFileSync(path.join(releaseDir, 'scripts', 'install-release.sh'), '#!/usr/bin/env bash\n');
      fs.writeFileSync(path.join(releaseDir, 'vendor', 'glibc228-lib.tar.gz'), 'glibc');
      callback(null);
    },
    spawn: (command, args, options) => {
      spawned.push({ command, args, options });
      return { unref() {} };
    },
  });

  const status = await service.check({ force: true });
  assert.strictEqual(status.available, true);
  assert.strictEqual(status.installable, true);
  assert.strictEqual(status.latest.version, '2.0.5');
  assert.strictEqual(status.latest.assetName, 'farming-2.0.5.tar.gz');
  assert.strictEqual(status.latest.assetBundledGlibc, true);
  assert.deepStrictEqual(
    requestedUrls,
    ['https://updates.example.test/farming/manifest.json'],
    'update checks should use only the configured manifest URL'
  );

  const sourceDeployRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-source-deploy.'));
  fs.writeFileSync(path.join(sourceDeployRoot, 'package.json'), JSON.stringify({ version: '2.0.0' }));
  fs.writeFileSync(path.join(sourceDeployRoot, 'RELEASE.json'), JSON.stringify({
    type: 'source-deploy',
    releaseVersion: '2.0.5-1-gabc1234',
    packageVersion: '2.0.0',
    gitSha: 'abc1234',
  }));
  const sourceDeployService = new FarmingUpdateService({
    rootDir: sourceDeployRoot,
    configDir,
    manifestUrl: 'https://updates.example.test/farming/manifest.json',
    fetchJson: async (url) => {
      if (String(url).endsWith('/manifest.json')) {
        return {
          assets: [
            { type: 'app-bundle', file: 'farming-2.0.5.tar.gz', bundledGlibc: true },
          ],
        };
      }
      return release205;
    },
  });
  const sourceDeployStatus = await sourceDeployService.check({ force: true });
  assert.strictEqual(sourceDeployStatus.current.releaseVersion, '2.0.5-1-gabc1234');
  assert.strictEqual(sourceDeployStatus.current.packageVersion, '2.0.0');
  assert.strictEqual(sourceDeployStatus.available, false);

  const installState = await service.startInstall();
  assert.strictEqual(installState.phase, 'downloading');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.strictEqual(spawned.length, 1);
  assert.strictEqual(spawned[0].command, 'bash');
  assert.strictEqual(spawned[0].options.detached, true);
  assert.strictEqual(spawned[0].options.env.FARMING_INSTALL_DIR, rootDir);
  assert.strictEqual(downloadedUrls[0], 'https://updates.example.test/farming/farming-2.0.5.tar.gz');
  assert(spawned[0].args.join(' ').includes('install-release.sh install'));
  assert.strictEqual(service.installState.phase, 'installing');

  const glibcReleaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-release-glibc.'));
  fs.mkdirSync(path.join(glibcReleaseDir, 'vendor'), { recursive: true });
  fs.writeFileSync(path.join(glibcReleaseDir, 'RELEASE.json'), JSON.stringify({ bundledGlibc: true }));
  fs.writeFileSync(path.join(glibcReleaseDir, 'vendor', 'glibc228-lib.tar.gz'), 'glibc');
  assert.strictEqual(releaseHasBundledGlibc(glibcReleaseDir), true);

  const unsafeStatusService = new FarmingUpdateService({
    rootDir,
    configDir,
    manifestUrl: 'https://updates.example.test/farming/manifest.json',
    fetchJson: async (url) => {
      if (String(url).endsWith('/manifest.json')) {
        return {
          assets: [
            { type: 'app-bundle', file: 'farming-2.0.6.tar.gz', bundledGlibc: false },
          ],
        };
      }
      return {
        tag_name: 'v2.0.6',
        name: 'Farming 2.0.6',
        assets: [
          { name: 'farming-2.0.6.tar.gz', browser_download_url: 'https://example.invalid/farming-2.0.6.tar.gz', size: 1024 },
          { name: 'manifest.json', browser_download_url: 'https://example.invalid/manifest.json', size: 512 },
        ],
      };
    },
  });
  const unsafeStatus = await unsafeStatusService.check({ force: true });
  assert.strictEqual(unsafeStatus.available, false);
  assert.strictEqual(unsafeStatus.installable, false);
  assert.strictEqual(unsafeStatus.latest.assetBundledGlibc, false);
  assert.match(unsafeStatus.latest.blockedReason, /does not declare bundled glibc/);

  const unbundledSpawned = [];
  const unbundledService = new FarmingUpdateService({
    rootDir,
    configDir,
    manifestUrl: 'https://updates.example.test/farming/manifest.json',
    fetchJson: async (url) => {
      if (String(url).endsWith('/manifest.json')) {
        return {
          assets: [
            { type: 'app-bundle', file: 'farming-2.0.6.tar.gz', bundledGlibc: true },
          ],
        };
      }
      return {
        tag_name: 'v2.0.6',
        name: 'Farming 2.0.6',
        assets: [
          { name: 'farming-2.0.6.tar.gz', browser_download_url: 'https://example.invalid/farming-2.0.6.tar.gz', size: 1024 },
          { name: 'manifest.json', browser_download_url: 'https://example.invalid/manifest.json', size: 512 },
        ],
      };
    },
    downloadFile: async (_url, outputPath) => {
      fs.writeFileSync(outputPath, 'archive');
    },
    execFile: (_command, args, callback) => {
      const extractRoot = args[args.indexOf('-C') + 1];
      const releaseDir = path.join(extractRoot, 'farming-2.0.6');
      fs.mkdirSync(path.join(releaseDir, 'scripts'), { recursive: true });
      fs.writeFileSync(path.join(releaseDir, 'RELEASE.json'), JSON.stringify({ bundledGlibc: false }));
      fs.writeFileSync(path.join(releaseDir, 'scripts', 'install-release.sh'), '#!/usr/bin/env bash\n');
      callback(null);
    },
    spawn: (command, args, options) => {
      unbundledSpawned.push({ command, args, options });
      return { unref() {} };
    },
  });
  await unbundledService.startInstall();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.strictEqual(unbundledSpawned.length, 0);
  assert.strictEqual(unbundledService.installState.phase, 'failed');
  assert.match(unbundledService.installState.error, /does not bundle glibc/);

  const failingUrls = [];
  const failingService = new FarmingUpdateService({
    rootDir,
    configDir,
    manifestUrl: 'https://updates.example.test/farming/missing-manifest.json',
    fetchJson: async (url) => {
      failingUrls.push(String(url));
      throw new Error('manifest unavailable');
    },
  });
  await assert.rejects(() => failingService.check({ force: true }), /manifest unavailable/);
  assert.deepStrictEqual(failingUrls, ['https://updates.example.test/farming/missing-manifest.json']);

  console.log('✓ Farming update service uses only configured HTTP manifests');
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
