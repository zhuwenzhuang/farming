#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { FarmingUpdateService } = require('../backend/update-service');

const RELEASE_PAGE_URL = 'https://github.com/example/farming/releases/latest';
const EXPANDED_ASSETS_URL = 'https://github.com/example/farming/releases/expanded_assets/v2.3.0';

function fixtureFetchText(url) {
  if (url === RELEASE_PAGE_URL) return '<a href="/example/farming/releases/tag/v2.3.0">v2.3.0</a>';
  if (url === EXPANDED_ASSETS_URL) {
    return [
      '<a href="/example/farming/releases/download/v2.3.0/farming-2.3.0-darwin-arm64.tar.gz">macOS</a>',
      '<a href="/example/farming/releases/download/v2.3.0/farming-2.3.0-linux-x64.tar.gz">Linux</a>',
      '<a href="/example/farming/releases/download/v2.3.0/farming_2.3.0_checksums.txt">checksums</a>',
    ].join('\n');
  }
  throw new Error(`unexpected update URL: ${url}`);
}

async function compatibleAssetsFor(platform, arch) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-update-platform-root.'));
  fs.writeFileSync(path.join(rootDir, 'package.json'), JSON.stringify({ version: '2.2.0' }));
  const service = new FarmingUpdateService({
    rootDir,
    configDir: fs.mkdtempSync(path.join(os.tmpdir(), 'farming-update-platform-config.')),
    installMethod: 'app-bundle',
    platform,
    arch,
    manifestUrl: RELEASE_PAGE_URL,
    fetchText: async url => fixtureFetchText(url),
  });
  const status = await service.check({ force: true });
  return status.versions.map(version => version.assetName);
}

async function run() {
  assert.deepStrictEqual(
    await compatibleAssetsFor('darwin', 'arm64'),
    ['farming-2.3.0-darwin-arm64.tar.gz'],
    'macOS must not receive the Linux app bundle'
  );
  assert.deepStrictEqual(
    await compatibleAssetsFor('linux', 'x64'),
    ['farming-2.3.0-linux-x64.tar.gz'],
    'Linux must not receive the macOS app bundle'
  );
  console.log('✓ local update platform smoke covers macOS and Linux asset selection');
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
