const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  initializeCurrentPackageImage,
  publishRunningPackageImage,
  readCurrentPackagePointer,
  readPackageImageMarker,
  resolvePackageInstallationContext,
} = require('../package-installation.cjs');

const repositoryRoot = path.join(__dirname, '..', '..');

function writePackage(packageRoot, version) {
  fs.mkdirSync(path.join(packageRoot, 'backend'), { recursive: true });
  fs.mkdirSync(path.join(packageRoot, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(packageRoot, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({
    name: 'farming-code',
    version,
    scripts: { postinstall: 'node scripts/prepare-installed-runtime.cjs' },
  }));
  fs.writeFileSync(path.join(packageRoot, 'package-lock.json'), JSON.stringify({ version }));
  fs.copyFileSync(
    path.join(repositoryRoot, 'scripts', 'prepare-installed-runtime.cjs'),
    path.join(packageRoot, 'scripts', 'prepare-installed-runtime.cjs'),
  );
  fs.copyFileSync(path.join(repositoryRoot, 'bin', 'farming'), path.join(packageRoot, 'bin', 'farming'));
  for (const name of ['package-installation.cjs', 'config-instance.cjs', 'server-process-identity.cjs']) {
    fs.copyFileSync(path.join(repositoryRoot, 'backend', name), path.join(packageRoot, 'backend', name));
  }
  fs.writeFileSync(path.join(packageRoot, 'backend', 'farming-app-cli.cjs'), [
    `const fs = require('fs');`,
    `const path = require('path');`,
    `async function run(args = process.argv.slice(2)) {`,
    `  if (process.env.FARMING_TEST_RUNTIME_PREPARE_EXIT_CODE) return Number(process.env.FARMING_TEST_RUNTIME_PREPARE_EXIT_CODE);`,
    `  const configIndex = args.indexOf('--config-dir');`,
    `  if (configIndex < 0 || !args[configIndex + 1]) return 64;`,
    `  const seedDir = path.resolve(args[configIndex + 1]);`,
    `  fs.mkdirSync(seedDir, { recursive: true });`,
    `  fs.writeFileSync(path.join(seedDir, 'prepared.json'), JSON.stringify({`,
    `    args,`,
    `    packageRoot: path.resolve(__dirname, '..'),`,
    `    installationEnvironment: {`,
    `      id: process.env.FARMING_PACKAGE_INSTALLATION_ID || null,`,
    `      root: process.env.FARMING_PACKAGE_INSTALLATION_ROOT || null,`,
    `      bootstrapRoot: process.env.FARMING_BOOTSTRAP_PACKAGE_ROOT || null,`,
    `    },`,
    `  }));`,
    `  return 0;`,
    `}`,
    `module.exports = { run };`,
    `if (require.main === module) run().then(code => { if (code) process.exit(code); });`,
    '',
  ].join('\n'));
}

function runPostinstall(packageRoot, environment: NodeJS.ProcessEnv = {}) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.FARMING_NODE_BIN;
  delete env.FARMING_NODE_LD;
  delete env.FARMING_NODE_LIBRARY_PATH;
  for (const [name, value] of Object.entries(environment)) {
    if (value === undefined) delete env[name];
    else env[name] = value;
  }
  delete env.FARMING_SKIP_INSTALL_RUNTIME_PREPARE;
  return spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'postinstall'], {
    cwd: packageRoot,
    env,
    encoding: 'utf8',
  });
}

function assertPostinstallSucceeded(result) {
  assert.strictEqual(
    result.status,
    0,
    `postinstall failed\nstdout:\n${result.stdout || ''}\nstderr:\n${result.stderr || ''}`,
  );
}

function run() {
  if (process.platform === 'win32') {
    console.log('Installed runtime preparer package-image tests skipped on Windows');
    return;
  }

  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-installed-runtime-preparer-'));
  try {
    const bootstrapRoot = path.join(fixtureRoot, 'bootstrap', 'farming-code');
    const installationsDir = path.join(fixtureRoot, 'installations');
    writePackage(bootstrapRoot, '2.2.5');
    const context = resolvePackageInstallationContext(bootstrapRoot, {
      FARMING_PACKAGE_INSTALLATIONS_DIR: installationsDir,
    });
    assert(context);
    const runningImage = publishRunningPackageImage(context, bootstrapRoot);
    const initialPointer = initializeCurrentPackageImage(context, runningImage);
    const initialPointerBytes = fs.readFileSync(context.currentFile);
    const initialVersions = fs.readdirSync(context.versionsDir).sort();
    const installationEnvironment = {
      FARMING_PACKAGE_INSTALLATION_ID: context.installationId,
      FARMING_PACKAGE_INSTALLATION_ROOT: context.installationRoot,
      FARMING_BOOTSTRAP_PACKAGE_ROOT: context.bootstrapPackageRoot,
    };

    const targetRoot = path.join(context.stagingDir, 'target', 'lib', 'node_modules', 'farming-code');
    writePackage(targetRoot, '2.3.0');
    assertPostinstallSucceeded(runPostinstall(targetRoot, installationEnvironment));
    const prepared = JSON.parse(fs.readFileSync(path.join(targetRoot, '.farming-runtime-seed', 'prepared.json'), 'utf8'));
    assert.deepStrictEqual(
      prepared.args,
      ['runtime', 'prepare', '--config-dir', path.join(targetRoot, '.farming-runtime-seed'), '--no-activate'],
    );
    assert.strictEqual(prepared.packageRoot, fs.realpathSync.native(targetRoot));
    assert.deepStrictEqual(prepared.installationEnvironment, {
      id: context.installationId,
      root: context.installationRoot,
      bootstrapRoot: context.bootstrapPackageRoot,
    });
    assert.deepStrictEqual(readCurrentPackagePointer(context), initialPointer);
    assert.deepStrictEqual(fs.readFileSync(context.currentFile), initialPointerBytes);
    assert.deepStrictEqual(fs.readdirSync(context.versionsDir).sort(), initialVersions);
    assert.strictEqual(readPackageImageMarker(targetRoot), null, 'postinstall must not publish the staging package');

    const failedTargetRoot = path.join(context.stagingDir, 'failed', 'lib', 'node_modules', 'farming-code');
    writePackage(failedTargetRoot, '2.3.1');
    const failed = runPostinstall(failedTargetRoot, {
      ...installationEnvironment,
      FARMING_TEST_RUNTIME_PREPARE_EXIT_CODE: '23',
    });
    assert.notStrictEqual(failed.status, 0, 'runtime preparation failure must fail postinstall');
    assert.deepStrictEqual(readCurrentPackagePointer(context), initialPointer);
    assert.deepStrictEqual(fs.readFileSync(context.currentFile), initialPointerBytes);
    assert.deepStrictEqual(fs.readdirSync(context.versionsDir).sort(), initialVersions);
    assert.strictEqual(readPackageImageMarker(failedTargetRoot), null, 'failed postinstall must not publish an image');
    assert.strictEqual(
      fs.existsSync(path.join(failedTargetRoot, '.farming-runtime-seed', 'prepared.json')),
      false,
      'failed runtime preparation must not claim a prepared seed',
    );

    const ordinaryRoot = path.join(fixtureRoot, 'ordinary-install', 'farming-code');
    writePackage(ordinaryRoot, '2.3.2');
    const installationVariableNames = [
      'FARMING_PACKAGE_INSTALLATION_ID',
      'FARMING_PACKAGE_INSTALLATION_ROOT',
      'FARMING_BOOTSTRAP_PACKAGE_ROOT',
      'FARMING_ACTIVE_PACKAGE_ROOT',
      'FARMING_MANAGED_PACKAGE_ROOT',
    ];
    const parentInstallationEnvironment = new Map(
      installationVariableNames.map(name => [name, process.env[name]]),
    );
    const ordinaryEnvironment: NodeJS.ProcessEnv = {};
    installationVariableNames.forEach(name => {
      process.env[name] = `inherited-${name.toLowerCase()}`;
      ordinaryEnvironment[name] = undefined;
    });
    try {
      assertPostinstallSucceeded(runPostinstall(ordinaryRoot, ordinaryEnvironment));
    } finally {
      parentInstallationEnvironment.forEach((value, name) => {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      });
    }
    const ordinaryPrepared = JSON.parse(fs.readFileSync(
      path.join(ordinaryRoot, '.farming-runtime-seed', 'prepared.json'),
      'utf8',
    ));
    assert.deepStrictEqual(ordinaryPrepared.installationEnvironment, {
      id: null,
      root: null,
      bootstrapRoot: null,
    });
    assert.strictEqual(
      fs.existsSync(path.join(ordinaryRoot, '.farming-runtime-seed', 'prepared.json')),
      true,
      'ordinary npm postinstall must still prepare its package-owned seed',
    );

    const loaderRoot = path.join(fixtureRoot, 'loader-install', 'farming-code');
    const loaderPath = path.join(fixtureRoot, 'loader.sh');
    const loaderLibraryPath = path.join(fixtureRoot, 'loader-libs');
    fs.mkdirSync(loaderLibraryPath);
    fs.writeFileSync(loaderPath, [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'test "$1" = "--library-path"',
      `test "$2" = ${JSON.stringify(loaderLibraryPath)}`,
      'shift 2',
      'exec "$@"',
      '',
    ].join('\n'), { mode: 0o755 });
    writePackage(loaderRoot, '2.3.3');
    assertPostinstallSucceeded(runPostinstall(loaderRoot, {
      FARMING_NODE_BIN: process.execPath,
      FARMING_NODE_LD: loaderPath,
      FARMING_NODE_LIBRARY_PATH: loaderLibraryPath,
    }));
    assert.strictEqual(
      fs.existsSync(path.join(loaderRoot, '.farming-runtime-seed', 'prepared.json')),
      true,
      'postinstall child Node must preserve the configured compatibility-loader invocation',
    );

    console.log('✓ installed runtime postinstall is package-local and selection-free');
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

run();
