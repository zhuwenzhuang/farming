const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const projectRoot = path.join(__dirname, '..', '..');
const removedSources = [
  'backend/agent-capability-mcp.cts',
  'backend/agent-capability-tokens.cts',
  'extensions/browser/backend/browser-mcp-server.cts',
  'extensions/computer/backend/computer-mcp-server.cts',
  'scripts/smoke-browser-mcp-process.ts',
  'scripts/smoke-computer-mcp-process.ts',
];
removedSources.forEach(relativePath => {
  assert.strictEqual(fs.existsSync(path.join(projectRoot, relativePath)), false, `${relativePath} must stay removed`);
});

const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
assert.strictEqual(packageJson.dependencies['@modelcontextprotocol/sdk'], undefined);
assert(!packageJson.bundledDependencies.includes('@modelcontextprotocol/sdk'));

const launcherFixture = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-launcher-exit.'));
try {
  fs.mkdirSync(path.join(launcherFixture, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(launcherFixture, 'backend'), { recursive: true });
  fs.mkdirSync(path.join(launcherFixture, 'extensions', 'browser', 'bin'), { recursive: true });
  fs.mkdirSync(path.join(launcherFixture, 'extensions', 'computer', 'bin'), { recursive: true });
  fs.copyFileSync(path.join(projectRoot, 'bin/farming'), path.join(launcherFixture, 'bin/farming'));
  fs.writeFileSync(path.join(launcherFixture, 'backend/package-installation.cjs'), `
exports.resolvePackageLaunch = () => ({ packageRoot: ${JSON.stringify(launcherFixture)}, context: null });
exports.applyPackageInstallationEnvironment = () => {};
`);
  fs.writeFileSync(path.join(launcherFixture, 'backend/farming-app-cli.cjs'), `
exports.run = async () => Number(process.env.FARMING_FIXTURE_EXIT_CODE || 0);
`);
  for (const command of ['browser', 'computer']) {
    fs.writeFileSync(path.join(launcherFixture, 'extensions', command, 'bin', `farming-${command}`), `
exports.main = async args => { process.stdout.write(${JSON.stringify(command)} + ':' + args.join(',')); };
`);
  }
  const exited = spawnSync(process.execPath, [path.join(launcherFixture, 'bin/farming'), 'status'], {
    env: { ...process.env, FARMING_FIXTURE_EXIT_CODE: '7' },
    encoding: 'utf8',
  });
  assert.strictEqual(exited.status, 7, exited.stderr);
  for (const command of ['browser', 'computer']) {
    const capability = spawnSync(process.execPath, [path.join(launcherFixture, 'bin/farming'), command, 'describe'], {
      encoding: 'utf8',
    });
    assert.strictEqual(capability.status, 0, capability.stderr);
    assert.strictEqual(capability.stdout, `${command}:describe`);
  }
} finally {
  fs.rmSync(launcherFixture, { recursive: true, force: true });
}

console.log('Capability CLI-only process boundary tests passed');
