const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  activatePackageImage,
  applyPackageInstallationEnvironment,
  initializeCurrentPackageImage,
  packageInstallationId,
  prunePackageImages,
  publishPreparedPackageImage,
  publishRunningPackageImage,
  readCurrentPackagePointer,
  readPackageImageMarker,
  registerPackageImageUsage,
  releasePackageImageUsage,
  resolvePackageInstallationContext,
  resolvePackageLaunch,
} = require('../package-installation.cjs');
const { readServerProcessIdentity } = require('../server-process-identity.cjs');

function writePackage(packageRoot, version) {
  fs.mkdirSync(path.join(packageRoot, 'backend'), { recursive: true });
  fs.mkdirSync(path.join(packageRoot, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({
    name: 'farming-code',
    version,
  }));
  fs.writeFileSync(path.join(packageRoot, 'package-lock.json'), JSON.stringify({ version }));
  fs.writeFileSync(path.join(packageRoot, 'backend', 'runtime.cjs'), `module.exports = ${JSON.stringify(version)};\n`);
  fs.writeFileSync(path.join(packageRoot, 'bin', 'farming'), '#!/usr/bin/env node\n', { mode: 0o755 });
}

function preparedPackage(root, version) {
  const packageRoot = path.join(root, `prepared-${version}-${Math.random().toString(16).slice(2)}`);
  writePackage(packageRoot, version);
  return packageRoot;
}

function run() {
  if (process.platform === 'win32') {
    console.log('Package installation process-identity tests skipped on Windows');
    return;
  }
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-package-installation-'));
  const bootstrapRoot = path.join(fixtureRoot, 'npm', 'lib', 'node_modules', 'farming-code');
  const bootstrapAlias = path.join(fixtureRoot, 'bootstrap-alias');
  const configDir = path.join(fixtureRoot, 'config');
  const storeBase = path.join(fixtureRoot, 'package-store');
  fs.mkdirSync(configDir);
  writePackage(bootstrapRoot, '2.2.33');
  fs.symlinkSync(bootstrapRoot, bootstrapAlias, 'dir');
  const env = { FARMING_PACKAGE_INSTALLATIONS_DIR: storeBase };

  try {
    const context = resolvePackageInstallationContext(bootstrapAlias, env);
    assert(context);
    assert.strictEqual(context.installationId, packageInstallationId(bootstrapRoot));
    assert.strictEqual(context.bootstrapPackageRoot, fs.realpathSync.native(bootstrapRoot));
    assert(context.installationRoot.startsWith(fs.realpathSync.native(fixtureRoot)));
    assert(context.installationRoot.includes(`${path.sep}package-store${path.sep}`));

    const sourceCheckout = path.join(fixtureRoot, 'source');
    writePackage(sourceCheckout, '2.2.33');
    fs.mkdirSync(path.join(sourceCheckout, '.git'));
    assert.strictEqual(resolvePackageInstallationContext(sourceCheckout, env), null);

    const running = publishRunningPackageImage(context, bootstrapRoot);
    assert.strictEqual(running.version, '2.2.33');
    assert.notStrictEqual(running.packageRoot, context.bootstrapPackageRoot);
    assert.strictEqual(readPackageImageMarker(running.packageRoot).installationId, context.installationId);
    const initial = initializeCurrentPackageImage(context, running);
    assert.strictEqual(initial.imageId, running.imageId);

    const targetPrepared = preparedPackage(fixtureRoot, '2.2.34');
    const target = publishPreparedPackageImage(context, targetPrepared, '2.2.34', 'sha512-target-234');
    assert.strictEqual(fs.existsSync(targetPrepared), false, 'publication must move the prepared image');
    const activated = activatePackageImage(context, target, running.imageId);
    assert.strictEqual(activated.changed, true);
    assert.strictEqual(activated.previous.imageId, running.imageId);
    assert.strictEqual(readCurrentPackagePointer(context).imageId, target.imageId);
    assert.throws(
      () => activatePackageImage(context, running, 'not-the-current-image'),
      /selection changed/,
    );

    const launch = resolvePackageLaunch(bootstrapRoot, env);
    assert.strictEqual(launch.packageRoot, target.packageRoot);
    const pinnedLaunch = resolvePackageLaunch(running.packageRoot, {});
    assert.strictEqual(pinnedLaunch.packageRoot, running.packageRoot, 'an image-local launcher must stay pinned');
    const launchedEnv = applyPackageInstallationEnvironment({}, context, target.packageRoot);
    assert.strictEqual(launchedEnv.FARMING_ACTIVE_PACKAGE_ROOT, target.packageRoot);
    assert.strictEqual(launchedEnv.FARMING_BOOTSTRAP_PACKAGE_ROOT, context.bootstrapPackageRoot);

    const processIdentity = readServerProcessIdentity(process.pid);
    assert(processIdentity);
    registerPackageImageUsage(context, configDir, running, processIdentity);

    const extras = [];
    for (let index = 0; index < 6; index += 1) {
      const version = `2.1.${index}`;
      extras.push(publishPreparedPackageImage(
        context,
        preparedPackage(fixtureRoot, version),
        version,
        `sha512-extra-${index}`,
      ));
    }
    const pruned = prunePackageImages(context, 1);
    assert.strictEqual(fs.existsSync(target.packageRoot), true, 'current image must be retained');
    assert.strictEqual(fs.existsSync(running.packageRoot), true, 'previous/live image must be retained');
    assert(pruned.removed.length >= 5, 'old unreferenced images should be pruned');

    const invalidUsageFile = path.join(context.usageDir, '0000000000000000.json');
    fs.writeFileSync(invalidUsageFile, '{not-json');
    assert.throws(
      () => prunePackageImages(context, 1),
      /usage record .* unreadable; refusing to prune/,
      'GC must fail closed when an exact usage record cannot be read',
    );
    fs.rmSync(invalidUsageFile);

    releasePackageImageUsage(context, configDir, processIdentity);
    const rolledBack = activatePackageImage(context, running, target.imageId);
    assert.strictEqual(rolledBack.current.imageId, running.imageId);
    assert.strictEqual(resolvePackageLaunch(bootstrapRoot, env).packageRoot, running.packageRoot);

    writePackage(bootstrapRoot, '2.3.0');
    const externallyInstalledLaunch = resolvePackageLaunch(bootstrapRoot, env);
    assert.notStrictEqual(externallyInstalledLaunch.packageRoot, bootstrapRoot);
    assert.strictEqual(readPackageImageMarker(externallyInstalledLaunch.packageRoot).version, '2.3.0');
    assert.strictEqual(
      readCurrentPackagePointer(context).imageId,
      readPackageImageMarker(externallyInstalledLaunch.packageRoot).imageId,
      'an explicit npm replacement of the bootstrap package must become the selection for new launches',
    );
    assert.strictEqual(
      resolvePackageLaunch(running.packageRoot, {}).packageRoot,
      running.packageRoot,
      'an already selected image-local launcher must remain pinned after an external npm replacement',
    );
    assert.strictEqual(
      fs.readdirSync(context.installationRoot).some(name => name.startsWith('.mutation.lock.stale-')),
      false,
      'completed selection mutations must not leak lock directories',
    );

    console.log('Package installation version-store tests passed');
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

run();
