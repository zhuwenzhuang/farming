const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function run() {
  if (process.platform !== 'linux') {
    console.log('✓ legacy app bin loader bootstrap test is Linux-only');
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-legacy-bin-bootstrap.'));
  const imageRoot = path.join(root, 'image');
  const backendDir = path.join(imageRoot, 'backend');
  const binDir = path.join(imageRoot, 'bin');
  const libraryDir = path.join(imageRoot, '.farming-glibc', 'lib');
  const loader = path.join(libraryDir, 'ld-2.28.so');
  const loaderLog = path.join(root, 'loader.log');
  try {
    fs.mkdirSync(backendDir, { recursive: true });
    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(libraryDir, { recursive: true });
    fs.copyFileSync(path.join(__dirname, '../../bin/farming'), path.join(binDir, 'farming'));
    fs.writeFileSync(path.join(backendDir, 'package-installation.cjs'), `
exports.resolvePackageLaunch = packageRoot => ({ packageRoot, context: null });
exports.applyPackageInstallationEnvironment = () => {};
`);
    fs.writeFileSync(path.join(backendDir, 'farming-app-cli.cjs'), `
exports.run = async () => {
  if (process.env.FARMING_NODE_LD !== ${JSON.stringify(loader)}) return 41;
  if (process.env.FARMING_NODE_LIBRARY_PATH !== ${JSON.stringify(libraryDir)}) return 42;
  return 0;
};
`);
    fs.writeFileSync(loader, `#!/bin/sh
printf '%s\\n' "$*" > "${loaderLog}"
shift 2
exec "$@"
`, { mode: 0o755 });

    const result = spawnSync(process.execPath, [path.join(binDir, 'farming'), 'daemon'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: path.join(root, 'home'),
        FARMING_CONFIG_DIR: path.join(root, 'config'),
      },
    });
    assert.strictEqual(result.status, 0, result.stderr);
    assert.match(fs.readFileSync(loaderLog, 'utf8'), /--library-path/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  console.log('✓ legacy app bin entry bootstraps its image-owned glibc loader');
}

run();
