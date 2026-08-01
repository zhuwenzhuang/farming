const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  canonicalConfigDir,
  configInstanceFingerprint,
} = require('../config-instance.cjs');

function run() {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-config-instance-'));

  try {
    const realParent = path.join(fixtureRoot, 'real-parent');
    const symlinkParent = path.join(fixtureRoot, 'symlink-parent');
    const existingConfig = path.join(realParent, 'existing-config');
    fs.mkdirSync(existingConfig, { recursive: true });
    fs.symlinkSync(realParent, symlinkParent, process.platform === 'win32' ? 'junction' : 'dir');

    const canonicalExisting = fs.realpathSync.native(existingConfig);
    assert.strictEqual(canonicalConfigDir(existingConfig), canonicalExisting);
    assert.strictEqual(
      canonicalConfigDir(path.join(symlinkParent, 'existing-config')),
      canonicalExisting,
      'a symlink alias must resolve to the same Config identity',
    );

    const missingViaRealPath = path.join(realParent, 'future', 'config');
    const missingViaSymlink = path.join(symlinkParent, 'future', 'config');
    assert.strictEqual(
      canonicalConfigDir(missingViaSymlink),
      canonicalConfigDir(missingViaRealPath),
      'a creatable Config path must canonicalize its nearest existing ancestor',
    );
    assert.strictEqual(
      fs.existsSync(missingViaRealPath),
      false,
      'canonicalization must not create the Config directory',
    );

    const fingerprint = configInstanceFingerprint(existingConfig);
    assert.match(fingerprint, /^[a-f0-9]{16}$/);
    assert.strictEqual(configInstanceFingerprint(existingConfig), fingerprint);
    assert.strictEqual(configInstanceFingerprint(path.join(symlinkParent, 'existing-config')), fingerprint);
    assert.notStrictEqual(
      configInstanceFingerprint(path.join(realParent, 'another-config')),
      fingerprint,
      'different canonical Config paths must not share the same ordinary fingerprint',
    );

    assert.throws(() => canonicalConfigDir(''), /FARMING_CONFIG_DIR must be a non-empty path/);

    console.log('test-config-instance passed');
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

run();
