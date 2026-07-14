const assert = require('assert');
const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const {
  FarmingUpdateService,
  compareVersions,
  detectInstallMethod,
  npmPackageMetadataUrl,
  npmVersionsFromMetadata,
  normalizeVersion,
  releaseInstallDir,
  releaseFromManifest,
  releaseFromDirectoryListing,
  releaseFromGitHubReleasePage,
  manifestAssetSafety,
  selectManifestAsset,
  selectReleaseAsset,
  validateArchiveEntries,
} = require('../update-service');

const VALID_SHA256 = 'a'.repeat(64);
const ARCHIVE_SHA256 = crypto.createHash('sha256').update('archive').digest('hex');

function waitFor(predicate, timeoutMs = 1000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - startedAt > timeoutMs) {
        reject(new Error('timed out waiting for update test condition'));
        return;
      }
      setTimeout(tick, 10);
    };
    tick();
  });
}

function createFakeBundle(rootDir, version, fileName) {
  const releaseDir = path.join(rootDir, `farming-${version}`);
  fs.mkdirSync(path.join(releaseDir, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(releaseDir, 'RELEASE.json'), JSON.stringify({
    releaseVersion: version,
    packageVersion: version,
  }));
  fs.writeFileSync(path.join(releaseDir, 'scripts', 'install-release.sh'), '#!/usr/bin/env bash\n');
  const archivePath = path.join(rootDir, fileName);
  childProcess.execFileSync('tar', ['-czf', archivePath, '-C', rootDir, `farming-${version}`]);
  return archivePath;
}

function createChecksumFile(archivePath) {
  const checksumPath = `${archivePath}.sha256`;
  const checksum = crypto.createHash('sha256').update(fs.readFileSync(archivePath)).digest('hex');
  fs.writeFileSync(checksumPath, `${checksum}  ${path.basename(archivePath)}\n`);
  return checksumPath;
}

async function withFakeUpdateServer(filesByName, visibleFiles, fn) {
  const server = http.createServer((request, response) => {
    const parsed = new URL(request.url || '/', 'http://127.0.0.1');
    if (parsed.pathname === '/farming/' || parsed.pathname === '/farming') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(visibleFiles.map(file => `<a href="${file}">${file}</a>`).join('\n'));
      return;
    }

    const fileName = path.basename(parsed.pathname);
    const filePath = filesByName.get(fileName);
    if (!filePath) {
      response.writeHead(404);
      response.end('not found');
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/gzip' });
    fs.createReadStream(filePath).pipe(response);
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}/farming/`;
  try {
    await fn(baseUrl);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

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
    manifestAssetSafety(selected, { assets: [{ file: 'farming-2.tar.gz', type: 'app-bundle', sha256: VALID_SHA256 }] }),
    { safe: true, reason: '' },
  );
  const missingChecksumSafety = manifestAssetSafety(selected, {
    assets: [{ file: 'farming-2.tar.gz', type: 'app-bundle' }],
  });
  assert.strictEqual(missingChecksumSafety.safe, false);
  assert.match(missingChecksumSafety.reason, /missing a SHA-256 checksum/);
  const publicManifestRelease = releaseFromManifest({
    releaseVersion: '2.0.5',
    tag: 'v2.0.5',
    assets: [
      { type: 'app-bundle', file: 'farming-2.0.5.tar.gz', sha256: VALID_SHA256 },
    ],
  }, { manifestUrl: 'https://updates.example.test/farming/manifest.json' });
  assert.strictEqual(publicManifestRelease.tag_name, 'v2.0.5');
  assert.strictEqual(publicManifestRelease.assets[0].name, 'farming-2.0.5.tar.gz');
  assert.strictEqual(publicManifestRelease.assets[0].sha256, VALID_SHA256);
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
    sha256: VALID_SHA256,
  }, { manifestUrl: 'https://updates.example.test/farming/manifest.json' });
  assert.strictEqual(simpleManifestRelease.tag_name, 'v2.0.7');
  assert.strictEqual(simpleManifestRelease.assets[0].name, 'farming-2.0.7.tar.gz');
  assert.strictEqual(simpleManifestRelease.assets[0].browser_download_url, 'https://updates.example.test/farming/farming-2.0.7.tar.gz');
  assert.strictEqual(
    manifestAssetSafety(simpleManifestRelease.assets[0], {
      version: '2.0.7',
      tarUrl: 'farming-2.0.7.tar.gz',
      sha256: VALID_SHA256,
    }).safe,
    true
  );
  const directoryRelease = releaseFromDirectoryListing(`
    <html><body>
      <a href="farming-2.0.9.tar.gz">farming-2.0.9.tar.gz</a>
      <a href="farming-2.1.0.tar.gz">farming-2.1.0.tar.gz</a>
      <a href="farming-2.1.0.tar.gz.sha256">checksum</a>
      <a href="farming-2.0.8.tar.gz">farming-2.0.8.tar.gz</a>
    </body></html>
  `, { directoryUrl: 'https://updates.example.test/farming/' });
  assert.strictEqual(directoryRelease.tag_name, 'v2.1.0');
  assert.strictEqual(directoryRelease.assets[0].name, 'farming-2.1.0.tar.gz');
  assert.strictEqual(directoryRelease.assets[0].browser_download_url, 'https://updates.example.test/farming/farming-2.1.0.tar.gz');
  assert.strictEqual(directoryRelease.assets.some(asset => asset.name.includes('sha256')), false);
  assert.deepStrictEqual(
    manifestAssetSafety(directoryRelease.assets[0], directoryRelease.__manifest),
    { safe: true, reason: '' },
    'directory listings should remain install-time checksum verified'
  );
  const githubPageRelease = releaseFromGitHubReleasePage(`
    <a href="/zhuwenzhuang/farming/releases/download/v2.1.1/farming-2.1.1-darwin-arm64.tar.gz">macOS</a>
    <a href="/zhuwenzhuang/farming/releases/download/v2.1.1/farming-2.1.1-linux-x64.tar.gz">Linux</a>
    <a href="/zhuwenzhuang/farming/releases/download/v2.1.1/farming_2.1.1_checksums.txt">checksums</a>
  `, { pageUrl: 'https://github.com/zhuwenzhuang/farming/releases/latest' });
  assert.deepStrictEqual(
    githubPageRelease.assets.map(asset => `${asset.name}:${asset.platform}-${asset.arch}`),
    ['farming-2.1.1-darwin-arm64.tar.gz:darwin-arm64', 'farming-2.1.1-linux-x64.tar.gz:linux-x64']
  );
  assert.strictEqual(
    githubPageRelease.assets[0].checksum_url,
    'https://github.com/zhuwenzhuang/farming/releases/download/v2.1.1/farming_2.1.1_checksums.txt'
  );
  const githubPageUrls = [];
  const githubPageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-github-page-root.'));
  fs.writeFileSync(path.join(githubPageRoot, 'package.json'), JSON.stringify({ version: '2.0.0' }));
  const githubPageService = new FarmingUpdateService({
    rootDir: githubPageRoot,
    configDir: fs.mkdtempSync(path.join(os.tmpdir(), 'farming-github-page-config.')),
    installMethod: 'app-bundle',
    platform: 'darwin',
    arch: 'arm64',
    manifestUrl: 'https://github.com/example/farming/releases/latest',
    fetchText: async url => {
      githubPageUrls.push(String(url));
      if (String(url).endsWith('/releases/latest')) return '<a href="/example/farming/releases/tag/v2.1.1">v2.1.1</a>';
      return `
        <a href="/example/farming/releases/download/v2.1.1/farming-2.1.1-darwin-arm64.tar.gz">macOS</a>
        <a href="/example/farming/releases/download/v2.1.1/farming-2.1.1-linux-x64.tar.gz">Linux</a>
        <a href="/example/farming/releases/download/v2.1.1/farming_2.1.1_checksums.txt">checksums</a>
      `;
    },
  });
  const githubPageStatus = await githubPageService.check({ force: true });
  assert.deepStrictEqual(githubPageUrls, [
    'https://github.com/example/farming/releases/latest',
    'https://github.com/example/farming/releases/expanded_assets/v2.1.1',
  ]);
  assert.deepStrictEqual(githubPageStatus.versions.map(version => version.assetName), ['farming-2.1.1-darwin-arm64.tar.gz']);
  assert.throws(() => validateArchiveEntries(['farming-2.0.7/', '../escape']), /path traversal/);
  assert.throws(() => validateArchiveEntries(['first/file', 'second/file']), /one top-level directory/);

  let redirectedAuthorization = null;
  const redirectTarget = http.createServer((request, response) => {
    redirectedAuthorization = request.headers.authorization || '';
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end('{}');
  });
  await new Promise(resolve => redirectTarget.listen(0, '127.0.0.1', resolve));
  const redirectTargetUrl = `http://127.0.0.1:${redirectTarget.address().port}/manifest.json`;
  const redirectSource = http.createServer((_request, response) => {
    response.writeHead(302, { Location: redirectTargetUrl });
    response.end();
  });
  await new Promise(resolve => redirectSource.listen(0, '127.0.0.1', resolve));
  try {
    const redirectService = new FarmingUpdateService({ authToken: 'update-secret' });
    await redirectService.fetchJson(`http://127.0.0.1:${redirectSource.address().port}/manifest.json`, {
      authToken: 'update-secret',
    });
    assert.strictEqual(redirectedAuthorization, '', 'update auth tokens must not cross origin redirects');
  } finally {
    await new Promise(resolve => redirectSource.close(resolve));
    await new Promise(resolve => redirectTarget.close(resolve));
  }

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
  assert.match(unconfiguredStatus.latest.blockedReason, /empty/);
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
            { type: 'app-bundle', file: 'farming-2.0.5.tar.gz', sha256: ARCHIVE_SHA256 },
          ],
        };
      }
      return release205;
    },
    downloadFile: async (url, outputPath) => {
      downloadedUrls.push(String(url));
      fs.writeFileSync(outputPath, 'archive');
    },
    listArchiveEntries: async () => ['farming-2.0.5/', 'farming-2.0.5/scripts/install-release.sh'],
    execFile: (_command, args, callback) => {
      const extractRoot = args[args.indexOf('-C') + 1];
      const releaseDir = path.join(extractRoot, 'farming-2.0.5');
      fs.mkdirSync(path.join(releaseDir, 'scripts'), { recursive: true });
      fs.writeFileSync(path.join(releaseDir, 'RELEASE.json'), JSON.stringify({}));
      fs.writeFileSync(path.join(releaseDir, 'scripts', 'install-release.sh'), '#!/usr/bin/env bash\n');
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
  assert.deepStrictEqual(
    requestedUrls,
    ['https://updates.example.test/farming/manifest.json'],
    'update checks should use only the configured manifest URL'
  );

  const macRuntimeService = new FarmingUpdateService({
    rootDir,
    configDir,
    platform: 'darwin',
    arch: 'arm64',
    manifestUrl: 'https://updates.example.test/farming/manifest.json',
    fetchJson: async () => ({
      releaseVersion: '2.0.6',
      assets: [
        { type: 'app-bundle', file: 'farming-2.0.6-darwin-arm64.tar.gz', platform: 'darwin', arch: 'arm64', sha256: VALID_SHA256 },
        { type: 'app-bundle', file: 'farming-2.0.6-linux-x64.tar.gz', platform: 'linux', arch: 'x64', sha256: VALID_SHA256 },
        { type: 'app-bundle', file: 'farming-2.0.6.tar.gz', sha256: VALID_SHA256 },
      ],
    }),
  });
  const macRuntimeStatus = await macRuntimeService.check({ force: true });
  assert.deepStrictEqual(
    macRuntimeStatus.versions.map(version => version.assetName),
    ['farming-2.0.6-darwin-arm64.tar.gz'],
    'updates must only offer app bundles that explicitly match the running platform and architecture'
  );
  assert.deepStrictEqual(macRuntimeStatus.runtime, { platform: 'darwin', arch: 'arm64' });

  const linuxManifest = {
    releaseVersion: '2.0.6',
    assets: [
      { type: 'app-bundle', file: 'farming-2.0.6-linux-x64-legacy-glibc228.tar.gz', platform: 'linux', arch: 'x64', compatibilityProfile: 'linux-x64-legacy-glibc228', sha256: VALID_SHA256 },
      { type: 'app-bundle', file: 'farming-2.0.6-linux-x64.tar.gz', platform: 'linux', arch: 'x64', compatibilityProfile: '', sha256: VALID_SHA256 },
    ],
  };
  const standardLinuxService = new FarmingUpdateService({
    rootDir,
    configDir,
    platform: 'linux',
    arch: 'x64',
    manifestUrl: 'https://updates.example.test/farming/manifest.json',
    fetchJson: async () => linuxManifest,
  });
  const standardLinuxStatus = await standardLinuxService.check({ force: true });
  assert.strictEqual(standardLinuxStatus.latest.assetName, 'farming-2.0.6-linux-x64.tar.gz');

  fs.writeFileSync(path.join(rootDir, 'RELEASE.json'), JSON.stringify({
    releaseVersion: '2.0.0',
    packageVersion: '2.0.0',
    compatibilityProfile: 'linux-x64-legacy-glibc228',
    bundledGlibcRuntime: true,
  }));
  const legacyLinuxService = new FarmingUpdateService({
    rootDir,
    configDir,
    platform: 'linux',
    arch: 'x64',
    manifestUrl: 'https://updates.example.test/farming/manifest.json',
    fetchJson: async () => linuxManifest,
  });
  const legacyLinuxStatus = await legacyLinuxService.check({ force: true });
  assert.strictEqual(legacyLinuxStatus.latest.assetName, 'farming-2.0.6-linux-x64-legacy-glibc228.tar.gz');
  assert.strictEqual(legacyLinuxStatus.current.compatibilityProfile, 'linux-x64-legacy-glibc228');
  assert.deepStrictEqual(
    legacyLinuxStatus.versions.map(version => version.assetName),
    ['farming-2.0.6-linux-x64-legacy-glibc228.tar.gz'],
    'legacy installations must not offer an incompatible standard bundle update'
  );
  fs.rmSync(path.join(rootDir, 'RELEASE.json'));

  const githubListingService = new FarmingUpdateService({
    rootDir,
    configDir,
    platform: 'darwin',
    arch: 'arm64',
    manifestUrl: 'https://api.github.com/repos/example/farming/releases/latest',
    fetchJson: async () => ({
      tag_name: 'v2.0.7',
      assets: [
        { name: 'farming-2.0.7-darwin-arm64.tar.gz', browser_download_url: 'https://example.invalid/farming-2.0.7-darwin-arm64.tar.gz' },
        { name: 'farming-2.0.7-linux-x64.tar.gz', browser_download_url: 'https://example.invalid/farming-2.0.7-linux-x64.tar.gz' },
        { name: 'farming_2.0.7_checksums.txt', browser_download_url: 'https://example.invalid/farming_2.0.7_checksums.txt' },
      ],
    }),
  });
  const githubListingStatus = await githubListingService.check({ force: true });
  assert.deepStrictEqual(
    githubListingStatus.versions.map(version => version.assetName),
    ['farming-2.0.7-darwin-arm64.tar.gz'],
    'GitHub Release asset listings must be filtered without fetching a manifest'
  );
  assert.strictEqual(githubListingStatus.installable, true);

  const directoryUrls = [];
  const directoryService = new FarmingUpdateService({
    rootDir,
    configDir,
    manifestUrl: 'https://updates.example.test/farming/',
    fetchText: async (url) => {
      directoryUrls.push(String(url));
      return `
        <a href="farming-2.0.1.tar.gz">farming-2.0.1.tar.gz</a>
        <a href="farming-2.0.1.tar.gz.sha256">checksum</a>
        <a href="farming-2.0.4.tar.gz">farming-2.0.4.tar.gz</a>
        <a href="farming-2.0.4.tar.gz.sha256">checksum</a>
        <a href="farming-2.0.3.tar.gz">farming-2.0.3.tar.gz</a>
        <a href="farming-2.0.3.tar.gz.sha256">checksum</a>
      `;
    },
    fetchJson: async () => {
      throw new Error('directory update source must not fetch JSON');
    },
  });
  const directoryStatus = await directoryService.check({ force: true });
  assert.strictEqual(directoryStatus.available, true);
  assert.strictEqual(directoryStatus.latest.version, '2.0.4');
  assert.strictEqual(directoryStatus.latest.assetName, 'farming-2.0.4.tar.gz');
  assert.deepStrictEqual(
    directoryStatus.versions.map(version => version.assetName),
    ['farming-2.0.4.tar.gz', 'farming-2.0.3.tar.gz', 'farming-2.0.1.tar.gz']
  );
  assert.deepStrictEqual(directoryUrls, ['https://updates.example.test/farming/']);

  let configuredUpdateUrl = 'https://updates.example.test/farming/';
  const dynamicUrls = [];
  const dynamicService = new FarmingUpdateService({
    rootDir,
    configDir,
    getUpdateUrl: () => configuredUpdateUrl,
    fetchText: async (url) => {
      dynamicUrls.push(String(url));
      return '<a href="farming-code-v2.0.4-node22-linux-x64.tar.gz">2.0.4</a><a href="farming-code-v2.0.4-node22-linux-x64.tar.gz.sha256">checksum</a>';
    },
  });
  const dynamicStatus = await dynamicService.check({ force: true });
  assert.strictEqual(dynamicStatus.available, true);
  assert.strictEqual(dynamicStatus.latest.version, '2.0.4');
  assert.strictEqual(dynamicStatus.latest.assetName, 'farming-code-v2.0.4-node22-linux-x64.tar.gz');
  configuredUpdateUrl = '';
  const disabledDynamicStatus = await dynamicService.check({ force: true });
  assert.strictEqual(disabledDynamicStatus.available, false);
  assert.strictEqual(disabledDynamicStatus.latest.source, '');
  assert.deepStrictEqual(dynamicUrls, ['https://updates.example.test/farming/']);

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
            { type: 'app-bundle', file: 'farming-2.0.5.tar.gz', sha256: VALID_SHA256 },
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

  const plainBundleSpawned = [];
  const plainBundleService = new FarmingUpdateService({
    rootDir,
    configDir,
    manifestUrl: 'https://updates.example.test/farming/manifest.json',
    fetchJson: async (url) => {
      if (String(url).endsWith('/manifest.json')) {
        return {
          assets: [
            { type: 'app-bundle', file: 'farming-2.0.6.tar.gz', sha256: ARCHIVE_SHA256 },
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
    listArchiveEntries: async () => ['farming-2.0.6/', 'farming-2.0.6/scripts/install-release.sh'],
    execFile: (_command, args, callback) => {
      const extractRoot = args[args.indexOf('-C') + 1];
      const releaseDir = path.join(extractRoot, 'farming-2.0.6');
      fs.mkdirSync(path.join(releaseDir, 'scripts'), { recursive: true });
      fs.writeFileSync(path.join(releaseDir, 'RELEASE.json'), JSON.stringify({}));
      fs.writeFileSync(path.join(releaseDir, 'scripts', 'install-release.sh'), '#!/usr/bin/env bash\n');
      callback(null);
    },
    spawn: (command, args, options) => {
      plainBundleSpawned.push({ command, args, options });
      return { unref() {} };
    },
  });
  await plainBundleService.startInstall();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.strictEqual(plainBundleSpawned.length, 1);
  assert.strictEqual(plainBundleService.installState.phase, 'installing');

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

  const httpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-http-update-root.'));
  const httpInstallRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-http-install.'));
  const httpConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-http-config.'));
  fs.writeFileSync(path.join(httpInstallRoot, 'package.json'), JSON.stringify({ version: '1.0.0' }));
  fs.writeFileSync(path.join(httpInstallRoot, '.farming.pid'), '12345\n');
  fs.writeFileSync(path.join(httpConfigDir, 'settings.json'), JSON.stringify({
    updateUrl: 'will-be-overwritten-by-test-server',
    workspaceHistory: ['/kept/workspace'],
  }));

  const bundle101 = 'farming-code-v1.0.1-node22-linux-x64.tar.gz';
  const bundle102 = 'farming-code-v1.0.2-node22-linux-x64.tar.gz';
  const bundle101Path = createFakeBundle(httpRoot, '1.0.1', bundle101);
  const bundle102Path = createFakeBundle(httpRoot, '1.0.2', bundle102);
  const filesByName = new Map([
    [bundle101, bundle101Path],
    [`${bundle101}.sha256`, createChecksumFile(bundle101Path)],
    [bundle102, bundle102Path],
    [`${bundle102}.sha256`, createChecksumFile(bundle102Path)],
  ]);
  const visibleFiles = [bundle101, `${bundle101}.sha256`];

  await withFakeUpdateServer(filesByName, visibleFiles, async (baseUrl) => {
    visibleFiles.push(bundle102, `${bundle102}.sha256`);
    const selectedSpawned = [];
    const selectedService = new FarmingUpdateService({
      rootDir: httpInstallRoot,
      configDir: httpConfigDir,
      getUpdateUrl: () => baseUrl,
      spawn: (command, args, options) => {
        selectedSpawned.push({ command, args, options });
        return { unref() {} };
      },
    });
    const selectedStatus = await selectedService.check({ force: true, assetName: bundle101 });
    assert.strictEqual(selectedStatus.latest.version, '1.0.2');
    assert.strictEqual(selectedStatus.latest.assetName, bundle102);
    assert.strictEqual(selectedStatus.selected.version, '1.0.1');
    assert.strictEqual(selectedStatus.selected.assetName, bundle101);
    assert.deepStrictEqual(selectedStatus.versions.map(version => version.assetName), [bundle102, bundle101]);
    await selectedService.startInstall({ assetName: bundle101 });
    await waitFor(() => selectedSpawned.length === 1);
    assert.strictEqual(selectedService.installState.version, '1.0.1');
    assert.strictEqual(selectedService.installState.assetName, bundle101);
    assert(selectedService.installState.releaseDir.endsWith('farming-1.0.1'));
    visibleFiles.splice(-2, 2);

    const firstSpawned = [];
    const firstService = new FarmingUpdateService({
      rootDir: httpInstallRoot,
      configDir: httpConfigDir,
      getUpdateUrl: () => baseUrl,
      spawn: (command, args, options) => {
        firstSpawned.push({ command, args, options });
        return { unref() {} };
      },
    });

    const firstStatus = await firstService.check({ force: true });
    assert.strictEqual(firstStatus.available, true);
    assert.strictEqual(firstStatus.latest.version, '1.0.1');
    assert.strictEqual(firstStatus.latest.assetName, bundle101);
    assert.strictEqual(firstStatus.latest.source, baseUrl);
    await firstService.startInstall();
    await waitFor(() => firstSpawned.length === 1);
    assert.strictEqual(firstSpawned[0].command, 'bash');
    assert.strictEqual(firstSpawned[0].options.env.FARMING_INSTALL_DIR, httpInstallRoot);
    assert.strictEqual(firstSpawned[0].options.env.FARMING_CONFIG_DIR, httpConfigDir);
    assert(fs.existsSync(path.join(firstService.installState.releaseDir, 'scripts', 'install-release.sh')));
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(httpConfigDir, 'settings.json'), 'utf8')).workspaceHistory, ['/kept/workspace']);

    fs.writeFileSync(path.join(httpInstallRoot, 'RELEASE.json'), JSON.stringify({
      type: 'app-bundle',
      releaseVersion: '1.0.1',
      packageVersion: '1.0.1',
    }));
    visibleFiles.push(bundle102, `${bundle102}.sha256`);

    const secondSpawned = [];
    const secondService = new FarmingUpdateService({
      rootDir: httpInstallRoot,
      configDir: httpConfigDir,
      getUpdateUrl: () => baseUrl,
      spawn: (command, args, options) => {
        secondSpawned.push({ command, args, options });
        return { unref() {} };
      },
    });
    const secondStatus = await secondService.check({ force: true });
    assert.strictEqual(secondStatus.available, true);
    assert.strictEqual(secondStatus.latest.version, '1.0.2');
    assert.strictEqual(secondStatus.latest.assetName, bundle102);
    await secondService.startInstall();
    await waitFor(() => secondSpawned.length === 1);
    assert.strictEqual(secondSpawned[0].options.env.FARMING_CONFIG_DIR, httpConfigDir);
  });

  const npmRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-npm-update-root.'));
  const npmConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-npm-update-config.'));
  fs.writeFileSync(path.join(npmRoot, 'package.json'), JSON.stringify({ name: 'farming-code', version: '2.2.5' }));
  fs.mkdirSync(path.join(npmRoot, 'bin'));
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
  assert.strictEqual(npmPackageMetadataUrl('https://registry.npmjs.org/', 'farming-code'), 'https://registry.npmjs.org/farming-code');
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
  const npmService = new FarmingUpdateService({
    rootDir: npmRoot,
    configDir: npmConfigDir,
    platform: 'darwin',
    arch: 'arm64',
    fetchJson: async url => {
      assert.strictEqual(String(url), 'https://registry.npmjs.org/farming-code');
      return npmMetadata;
    },
    spawn: (command, args, options) => {
      npmSpawned.push({ command, args, options });
      return { unref() {} };
    },
  });
  const npmStatus = await npmService.check({ force: true });
  assert.strictEqual(npmStatus.method, 'npm');
  assert.strictEqual(npmStatus.current.type, 'npm');
  assert.strictEqual(npmStatus.current.installDir, npmRoot);
  assert.strictEqual(npmStatus.latest.version, '2.3.0');
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
  const npmInstallState = await npmService.startInstall({ assetName: '2.2.6' });
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
  assert.strictEqual(npmInstallState.phase, 'installing');
  assert.strictEqual(npmSpawned.length, 1);
  assert.strictEqual(npmSpawned[0].command, '/opt/farming/glibc/lib/ld-linux-x86-64.so.2');
  assert.deepStrictEqual(npmSpawned[0].args.slice(0, 3), [
    '--library-path',
    '/opt/farming/glibc/lib',
    '/opt/farming/runtime/bin/node',
  ]);
  assert(npmSpawned[0].args[3].endsWith('/backend/npm-update-helper.js'));
  assert.strictEqual(npmSpawned[0].options.cwd, npmConfigDir);
  const npmUpdatePayload = JSON.parse(npmSpawned[0].options.env.FARMING_NPM_UPDATE_PAYLOAD);
  assert.strictEqual(npmUpdatePayload.targetVersion, '2.2.6');
  assert.strictEqual(npmUpdatePayload.previousVersion, '2.2.5');
  assert.strictEqual(npmUpdatePayload.configDir, npmConfigDir);
  assert.strictEqual(npmUpdatePayload.nodePath, '/opt/farming/runtime/bin/node');
  assert.strictEqual(npmUpdatePayload.npmCommand, '/opt/farming/runtime/bin/npm');
  assert.strictEqual(npmUpdatePayload.npmPrefix, '/opt/farming/npm');
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(npmConfigDir, 'farming-update.json'), 'utf8')).phase, 'installing');
  const sourceServiceWithNpmState = new FarmingUpdateService({
    rootDir: path.join(__dirname, '..', '..'),
    configDir: npmConfigDir,
    installMethod: 'source',
  });
  assert.strictEqual(sourceServiceWithNpmState.currentInstallState().phase, 'idle');

  const macSpawned = [];
  const macInstallService = new FarmingUpdateService({
    rootDir,
    configDir: fs.mkdtempSync(path.join(os.tmpdir(), 'farming-mac-install-config.')),
    platform: 'darwin',
    arch: 'arm64',
    manifestUrl: 'https://updates.example.test/farming/manifest.json',
    fetchJson: async () => ({
      releaseVersion: '2.0.6',
      assets: [
        { type: 'app-bundle', file: 'farming-2.0.6-darwin-arm64.tar.gz', platform: 'darwin', arch: 'arm64', sha256: ARCHIVE_SHA256 },
      ],
    }),
    downloadFile: async (_url, outputPath) => fs.writeFileSync(outputPath, 'archive'),
    listArchiveEntries: async () => ['farming-2.0.6-darwin-arm64/', 'farming-2.0.6-darwin-arm64/scripts/install-release.sh'],
    execFile: (_command, args, callback) => {
      const extractRoot = args[args.indexOf('-C') + 1];
      const releaseDir = path.join(extractRoot, 'farming-2.0.6-darwin-arm64');
      fs.mkdirSync(path.join(releaseDir, 'scripts'), { recursive: true });
      fs.writeFileSync(path.join(releaseDir, 'RELEASE.json'), JSON.stringify({ platform: 'darwin', arch: 'arm64' }));
      fs.writeFileSync(path.join(releaseDir, 'scripts', 'install-release.sh'), '#!/usr/bin/env bash\n');
      callback(null);
    },
    spawn: (command, args, options) => {
      macSpawned.push({ command, args, options });
      return { unref() {} };
    },
  });
  await macInstallService.startInstall();
  await waitFor(() => macSpawned.length === 1);
  assert.strictEqual(macInstallService.installState.phase, 'installing');
  assert.strictEqual(macSpawned[0].command, 'bash');

  console.log('✓ Farming update service uses configured HTTP manifests and directory listings');
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
