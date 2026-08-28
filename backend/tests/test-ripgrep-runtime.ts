const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const {
  MANAGED_RIPGREP_VERSION,
  assertManagedRipgrep,
  canonicalManagedRipgrepPlatform,
  currentManagedRipgrepPlatform,
  managedRipgrepPath,
  materializeStandaloneRipgrep,
} = require('../ripgrep-runtime.cjs') as typeof import('../ripgrep-runtime.cjs');
const {
  managedRipgrepArchiveCacheRoot,
} = require('../../scripts/prepare-ripgrep-runtime.ts') as typeof import('../../scripts/prepare-ripgrep-runtime');

function run(): void {
  assert.strictEqual(canonicalManagedRipgrepPlatform('linux-x64-musl'), 'linux-x64');
  assert.strictEqual(canonicalManagedRipgrepPlatform('linux-arm64-musl'), 'linux-arm64');
  assert.strictEqual(currentManagedRipgrepPlatform(), `${process.platform}-${process.arch}`);
  const configuredArchiveCache = path.join(os.tmpdir(), 'farming-ripgrep-cache');
  assert.strictEqual(
    managedRipgrepArchiveCacheRoot({ FARMING_RIPGREP_ARCHIVE_CACHE: configuredArchiveCache }),
    configuredArchiveCache,
  );
  assert.match(
    managedRipgrepArchiveCacheRoot({}),
    /node_modules[\\/]\.cache[\\/]farming[\\/]ripgrep$/,
  );

  const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-rg-runtime-'));
  try {
    const platformKey = currentManagedRipgrepPlatform();
    const executable = managedRipgrepPath(platformKey, { FARMING_PACKAGED_RUNTIME_ROOT: packageRoot });
    fs.mkdirSync(path.dirname(executable), { recursive: true });
    fs.copyFileSync(managedRipgrepPath(), executable);
    if (process.platform !== 'win32') fs.chmodSync(executable, 0o755);
    assert.strictEqual(
      assertManagedRipgrep(platformKey, { FARMING_PACKAGED_RUNTIME_ROOT: packageRoot }),
      executable,
    );

    fs.writeFileSync(executable, 'not ripgrep', { mode: 0o755 });
    assert.throws(
      () => assertManagedRipgrep(platformKey, { FARMING_PACKAGED_RUNTIME_ROOT: packageRoot }),
      /managed ripgrep .* is corrupt/,
    );

    fs.rmSync(executable, { force: true });
    assert.throws(
      () => assertManagedRipgrep(platformKey, {
        FARMING_PACKAGED_RUNTIME_ROOT: packageRoot,
        FARMING_RG_BIN: process.execPath,
      }),
      /managed ripgrep .* is missing or not executable/,
      'a system or environment rg must not replace the managed runtime',
    );
    assert.throws(() => assertManagedRipgrep('freebsd-x64', {
      FARMING_PACKAGED_RUNTIME_ROOT: packageRoot,
    }), /does not provide ripgrep/);
  } finally {
    fs.rmSync(packageRoot, { recursive: true, force: true });
  }

  const managedExecutable = managedRipgrepPath();
  const version = execFileSync(managedExecutable, ['--version'], { encoding: 'utf8' });
  assert.match(version, new RegExp(`^ripgrep ${MANAGED_RIPGREP_VERSION.replaceAll('.', '\\.')}`));

  const standaloneRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-standalone-rg-'));
  try {
    const embeddedRoot = path.join(standaloneRoot, 'embedded');
    const embeddedExecutable = managedRipgrepPath(currentManagedRipgrepPlatform(), {
      FARMING_PACKAGED_RUNTIME_ROOT: embeddedRoot,
    });
    fs.mkdirSync(path.dirname(embeddedExecutable), { recursive: true });
    fs.copyFileSync(managedExecutable, embeddedExecutable);
    const standaloneEnv = { FARMING_CONFIG_DIR: path.join(standaloneRoot, 'config') };
    const materialized = materializeStandaloneRipgrep(
      currentManagedRipgrepPlatform(),
      standaloneEnv,
      embeddedRoot,
    );
    assert.strictEqual(materialized, managedRipgrepPath(currentManagedRipgrepPlatform(), standaloneEnv));
    assert.match(execFileSync(materialized, ['--version'], { encoding: 'utf8' }), /^ripgrep 15\.2\.0/);
  } finally {
    fs.rmSync(standaloneRoot, { recursive: true, force: true });
  }
  console.log('Managed ripgrep runtime resolution passed');
}

run();
