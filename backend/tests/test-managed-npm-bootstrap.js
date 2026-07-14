#!/usr/bin/env node
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { detectInstallMethod } = require('../update-service');

function writeExecutable(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, { mode: 0o755 });
}

function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-managed-npm-bootstrap.'));
  const sourceDir = path.join(root, 'release');
  const homeDir = path.join(root, 'home');
  const installer = path.join(sourceDir, 'scripts', 'install-release.sh');
  const env = {
    ...process.env,
    HOME: homeDir,
    FARMING_USE_GLIBC_RUNTIME: '0',
    FARMING_DISABLE_AUTH: '1',
    FARMING_NODE_MAX_OLD_SPACE_SIZE: '0',
  };

  try {
    fs.mkdirSync(path.join(sourceDir, 'dist'), { recursive: true });
    fs.mkdirSync(path.join(sourceDir, 'backend'), { recursive: true });
    fs.mkdirSync(path.join(sourceDir, 'bin'), { recursive: true });
    fs.mkdirSync(path.join(sourceDir, 'config'), { recursive: true });
    fs.mkdirSync(path.join(sourceDir, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(sourceDir, 'node_modules', 'express'), { recursive: true });
    fs.mkdirSync(path.join(sourceDir, 'node_modules', 'node-pty'), { recursive: true });
    fs.copyFileSync(path.join(process.cwd(), 'scripts', 'install-release.sh'), installer);
    fs.chmodSync(installer, 0o755);
    fs.writeFileSync(path.join(sourceDir, 'dist', 'index.html'), '<!doctype html>');
    fs.writeFileSync(path.join(sourceDir, 'package.json'), JSON.stringify({
      name: 'farming-code',
      version: '9.9.9',
    }));
    fs.writeFileSync(path.join(sourceDir, 'RELEASE.json'), JSON.stringify({
      type: 'app-bundle',
      updateMethod: 'npm',
      releaseVersion: '9.9.9',
      packageVersion: '9.9.9',
      compatibilityProfile: 'linux-x64-legacy-glibc228',
    }));
    writeExecutable(path.join(sourceDir, 'scripts', 'compute-node-heap-mb.sh'), '#!/usr/bin/env bash\necho 512\n');
    fs.writeFileSync(path.join(sourceDir, 'backend', 'server.js'), 'setInterval(() => {}, 1000);\n');
    writeExecutable(path.join(sourceDir, 'bin', 'farming'), [
      '#!/usr/bin/env node',
      'const fs = require("fs");',
      'const path = require("path");',
      'const { spawn } = require("child_process");',
      'const pidFile = path.join(process.env.HOME, ".farming", "farming-server.pid");',
      'if (process.argv[2] === "daemon") {',
      '  fs.mkdirSync(path.dirname(pidFile), { recursive: true });',
      '  const child = spawn(process.env.FARMING_NODE_BIN, [path.join(__dirname, "..", "backend", "server.js")], { detached: true, stdio: "ignore" });',
      '  child.unref();',
      '  fs.writeFileSync(pidFile, String(child.pid));',
      '  process.exit(0);',
      '}',
      'if (process.argv[2] === "stop") {',
      '  try { process.kill(Number(fs.readFileSync(pidFile, "utf8")), "SIGTERM"); } catch {}',
      '  fs.rmSync(pidFile, { force: true });',
      '  process.exit(0);',
      '}',
      'process.stdout.write(`${process.env.FARMING_NPM_PREFIX}|${process.env.FARMING_NODE_BIN}`);',
      '',
    ].join('\n'));

    execFileSync('bash', [installer, 'install'], { env, stdio: 'pipe' });

    const npmPrefix = path.join(homeDir, '.farming', 'npm');
    const installDir = path.join(npmPrefix, 'lib', 'node_modules', 'farming-code');
    const runtimeNode = path.join(homeDir, '.farming', 'runtime', 'bin', 'node');
    const stableCli = path.join(homeDir, '.farming', 'bin', 'farming');
    assert.strictEqual(detectInstallMethod(installDir), 'npm');
    assert(fs.existsSync(runtimeNode));
    assert(fs.existsSync(path.join(homeDir, '.farming', 'runtime', 'bin', 'npm')));
    assert(fs.existsSync(stableCli));
    const output = execFileSync(stableCli, ['help'], { env, encoding: 'utf8' });
    assert.strictEqual(output, `${npmPrefix}|${runtimeNode}`);
    assert(fs.existsSync(path.join(homeDir, '.farming', 'farming-server.pid')));

    execFileSync('bash', [installer, 'stop'], { env, stdio: 'pipe' });
    console.log('✓ legacy release bootstraps a stable launcher and npm-managed prefix');
  } finally {
    try {
      execFileSync('bash', [installer, 'stop'], { env, stdio: 'ignore' });
    } catch {
      // Best-effort cleanup for a failed assertion.
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

run();
