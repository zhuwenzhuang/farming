const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  loadFarmingNetRegistry,
  normalizeEndpointUrl,
  normalizeFarmingNetRegistry,
  writeFarmingNetRegistry,
} = require('../farming-net-registry');

function run() {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-net-registry-'));
  const registryFile = path.join(configDir, 'instances.json');

  try {
    assert.strictEqual(
      normalizeEndpointUrl('https://example.test/farming/?token=secret#agent'),
      'https://example.test/farming/',
      'the browser registry must not expose target tokens or fragments',
    );
    assert.strictEqual(normalizeEndpointUrl('https://user:secret@example.test/farming/'), '');
    assert.strictEqual(normalizeEndpointUrl('file:///tmp/farming'), '');

    const normalized = normalizeFarmingNetRegistry({
      version: 99,
      title: '  Team Farming  ',
      subtitle: 'One private index',
      instances: [
        {
          id: '  LOCAL.MAC ',
          name: ' Local Mac ',
          owner: 'Owner',
          description: 'Current workstation',
          federated: true,
          platform: 'macOS',
          pinned: true,
          endpoints: [
            { label: 'Open', url: 'http://127.0.0.1:6694/farming/?token=hidden', scope: 'this-device' },
            { label: 'Duplicate', url: 'http://127.0.0.1:6694/farming/', scope: 'remote' },
          ],
        },
        {
          id: 'local.mac',
          name: 'Duplicate id',
          endpoints: [{ label: 'Open', url: 'https://duplicate.test/farming/' }],
        },
        { id: '../bad', name: 'Invalid', endpoints: [{ url: 'https://example.test/' }] },
      ],
    });

    assert.strictEqual(normalized.version, 1);
    assert.strictEqual(normalized.title, 'Team Farming');
    assert.strictEqual(normalized.instances.length, 1);
    assert.strictEqual(normalized.instances[0].id, 'local.mac');
    assert.strictEqual(normalized.instances[0].federated, true);
    assert.strictEqual(normalized.instances[0].endpoints.length, 1);
    assert.strictEqual(normalized.instances[0].endpoints[0].url, 'http://127.0.0.1:6694/farming/');
    assert.strictEqual(normalized.instances[0].endpoints[0].primary, true);

    const written = writeFarmingNetRegistry(registryFile, normalized);
    assert.deepStrictEqual(loadFarmingNetRegistry(registryFile), written);
    assert.strictEqual(fs.statSync(registryFile).mode & 0o777, 0o600);

    fs.unlinkSync(registryFile);
    const empty = loadFarmingNetRegistry(registryFile);
    assert.deepStrictEqual(empty.instances, []);
    assert.strictEqual(fs.existsSync(registryFile), true);

    console.log('test-farming-net-registry passed');
  } finally {
    fs.rmSync(configDir, { recursive: true, force: true });
  }
}

run();
