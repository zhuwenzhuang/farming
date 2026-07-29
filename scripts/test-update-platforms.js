#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { FarmingUpdateService } = require('../backend/update-service.cjs');

async function unsupportedStatusFor(platform, arch) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-update-platform-root.'));
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-update-platform-config.'));
  fs.writeFileSync(path.join(rootDir, 'package.json'), JSON.stringify({ version: '2.2.0' }));
  let fetches = 0;
  const service = new FarmingUpdateService({
    rootDir,
    configDir,
    installMethod: 'app-bundle',
    platform,
    arch,
    fetchJson: async () => {
      fetches += 1;
      throw new Error('non-npm updates must not fetch a release source');
    },
  });
  const status = await service.check({ force: true });
  return { status, fetches };
}

async function run() {
  for (const [platform, arch] of [['darwin', 'arm64'], ['linux', 'x64']]) {
    const { status, fetches } = await unsupportedStatusFor(platform, arch);
    assert.strictEqual(status.method, 'app-bundle');
    assert.strictEqual(status.installable, false);
    assert.deepStrictEqual(status.versions, []);
    assert.match(status.latest.blockedReason, /reinstalling a release package or switching to npm/i);
    assert.strictEqual(fetches, 0);
  }
  console.log('✓ non-npm update smoke covers macOS and Linux');
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
