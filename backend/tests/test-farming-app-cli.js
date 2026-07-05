const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  buildCleanEnvExecCommand,
  buildControlEnv,
  buildServerEnv,
  parseServerArgs,
  serverStartTimeoutMs,
  serverStateFile,
  splitControlArgs,
} = require('../farming-app-cli');
const {
  buildCleanEnvExecCommand: buildNativeHostCleanEnvExecCommand,
  nativeHostSpawnCommand,
} = require('../native-pty-host-client');
const {
  WorkspaceFileService,
  isPackagedRuntime,
} = require('../workspace-file-service');

async function runTests() {
  {
    const parsed = parseServerArgs([
      'daemon',
      '--port',
      '7001',
      '--base-path',
      '/farm',
      '--config-dir',
      '/tmp/farming-cli-test',
      '--no-auth',
    ]);

    assert.strictEqual(parsed.command, 'daemon');
    assert.strictEqual(parsed.portExplicit, true);
    assert.strictEqual(parsed.env.PORT, '7001');
    assert.strictEqual(parsed.env.FARMING_BASE_PATH, '/farm');
    assert.strictEqual(parsed.env.FARMING_CONFIG_DIR, '/tmp/farming-cli-test');
    assert.strictEqual(parsed.env.FARMING_DISABLE_AUTH, '1');
  }

  {
    const parsed = parseServerArgs(['daemon', '--config-dir', '/tmp/farming-cli-test']);
    assert.strictEqual(parsed.command, 'daemon');
    assert.strictEqual(parsed.portExplicit, false);
  }

  {
    const env = buildServerEnv({
      FARMING_CONFIG_DIR: '/tmp/farming-default-config',
      FARMING_NODE_MAX_OLD_SPACE_SIZE: '0',
    }, {});

    assert.strictEqual(env.PORT, '6694');
    assert.strictEqual(env.FARMING_BASE_PATH, '/farming');
    assert.strictEqual(env.FARMING_CONFIG_DIR, '/tmp/farming-default-config');
    assert.strictEqual(env.FARMING_PACKAGED_RUNTIME, undefined);
    assert(!String(env.NODE_OPTIONS || '').includes('--max-old-space-size'));
  }

  {
    assert.strictEqual(serverStartTimeoutMs({}), 30_000);
    assert.strictEqual(serverStartTimeoutMs({ FARMING_START_TIMEOUT_MS: '45000' }), 45_000);
    assert.strictEqual(serverStartTimeoutMs({ FARMING_SERVER_START_TIMEOUT_MS: '12000' }), 12_000);
    assert.strictEqual(serverStartTimeoutMs({ FARMING_START_TIMEOUT_MS: 'nope' }), 30_000);
  }

  {
    const env = buildServerEnv({
      HOME: '/tmp/farming-home-config-test',
      PKG_EXECPATH: '/tmp/farming',
      FARMING_NODE_MAX_OLD_SPACE_SIZE: '0',
    }, {});

    assert.strictEqual(env.FARMING_CONFIG_DIR, '/tmp/farming-home-config-test/.farming');
    assert.strictEqual(env.PKG_EXECPATH, undefined);
  }

  {
    const env = buildServerEnv({
      FARMING_CONFIG_DIR: '/tmp/farming-default-config',
      FARMING_NODE_MAX_OLD_SPACE_SIZE: '1024',
      NODE_OPTIONS: '--trace-warnings',
    }, {});

    assert.strictEqual(env.FARMING_EFFECTIVE_NODE_HEAP_MB, '1024');
    assert(String(env.NODE_OPTIONS).includes('--trace-warnings'));
    assert(String(env.NODE_OPTIONS).includes('--max-old-space-size=1024'));
  }

  {
    const previous = process.env.FARMING_PACKAGED_RUNTIME;
    process.env.FARMING_PACKAGED_RUNTIME = '1';
    assert.strictEqual(isPackagedRuntime(), true);
    const service = new WorkspaceFileService();
    assert.strictEqual(service.commandRunner.ready, false);
    const result = await service.execFile(process.execPath, ['-e', 'process.stdout.write("ok")']);
    assert.strictEqual(result.stdout, 'ok');
    await service.dispose();
    if (previous === undefined) delete process.env.FARMING_PACKAGED_RUNTIME;
    else process.env.FARMING_PACKAGED_RUNTIME = previous;
  }

  {
    const command = buildCleanEnvExecCommand({
      PORT: '6694',
      FARMING_CONFIG_DIR: "/tmp/farming's config",
      'bad-key': 'skip',
    }, '/tmp/farming bin/farming', ['--']);

    assert(command.startsWith("'/usr/bin/env' '-i'"));
    assert(command.includes("'PORT=6694'"));
    assert(command.includes("'FARMING_CONFIG_DIR=/tmp/farming'\\''s config'"));
    assert(!command.includes('bad-key'));
    assert(command.endsWith("'/tmp/farming bin/farming' '--'"));
  }

  {
    const env = {
      FARMING_NODE_BIN: '/opt/farming/farming',
      FARMING_PACKAGED_RUNTIME: '1',
    };
    const command = nativeHostSpawnCommand('/snapshot/farming/backend/native-pty-host.js', env);

    assert.strictEqual(command.command, '/bin/sh');
    assert.strictEqual(command.args.length, 2);
    assert.strictEqual(command.args[0], '-c');
    assert(command.args[1].includes("'FARMING_RUN_NATIVE_PTY_HOST=1'"));
    assert(command.args[1].endsWith("'/opt/farming/farming' '--'"));
    assert.strictEqual(env.FARMING_RUN_NATIVE_PTY_HOST, '1');
  }

  {
    const command = nativeHostSpawnCommand('/repo/backend/native-pty-host.js', {
      FARMING_NODE_BIN: '/usr/bin/node',
    });

    assert.strictEqual(command.command, '/usr/bin/node');
    assert.deepStrictEqual(command.args, ['/repo/backend/native-pty-host.js']);
  }

  {
    const command = buildNativeHostCleanEnvExecCommand({
      FARMING_RUN_NATIVE_PTY_HOST: '1',
      FARMING_CONFIG_DIR: "/tmp/native host's config",
      'bad-key': 'skip',
    }, '/tmp/farming bin/farming', ['--']);

    assert(command.startsWith("'/usr/bin/env' '-i'"));
    assert(command.includes("'FARMING_RUN_NATIVE_PTY_HOST=1'"));
    assert(command.includes("'FARMING_CONFIG_DIR=/tmp/native host'\\''s config'"));
    assert(!command.includes('bad-key'));
    assert(command.endsWith("'/tmp/farming bin/farming' '--'"));
  }

  {
    const parsed = splitControlArgs([
      'spawn',
      '--config-dir',
      '/tmp/farming-control-config',
      '--port=7777',
      '--base-path',
      '/farm',
      '--workspace',
      '/repo',
      '--',
      '/bin/bash',
      '--config-dir',
      'child-keeps-this',
    ]);

    assert.deepStrictEqual(parsed.env, {
      FARMING_CONFIG_DIR: '/tmp/farming-control-config',
      PORT: '7777',
      FARMING_BASE_PATH: '/farm',
    });
    assert.deepStrictEqual(parsed.argv, [
      'spawn',
      '--workspace',
      '/repo',
      '--',
      '/bin/bash',
      '--config-dir',
      'child-keeps-this',
    ]);
  }

  {
    const env = buildControlEnv({
      FARMING_CONFIG_DIR: '/tmp/farming-control-config',
      PORT: '7777',
      FARMING_BASE_PATH: '/farm',
      FARMING_NODE_MAX_OLD_SPACE_SIZE: '0',
    }, {});

    assert.strictEqual(env.FARMING_CONTROL_URL, 'http://127.0.0.1:7777/farm');
    assert.strictEqual(env.FARMING_TOKEN_FILE, '/tmp/farming-control-config/.session-token');
  }

  {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-control-state.'));
    fs.writeFileSync(serverStateFile(configDir), JSON.stringify({
      port: 7788,
      basePath: '/farm-state',
    }));

    const env = buildControlEnv({
      FARMING_CONFIG_DIR: configDir,
      FARMING_NODE_MAX_OLD_SPACE_SIZE: '0',
    }, {});

    assert.strictEqual(env.PORT, '7788');
    assert.strictEqual(env.FARMING_BASE_PATH, '/farm-state');
    assert.strictEqual(env.FARMING_CONTROL_URL, 'http://127.0.0.1:7788/farm-state');
    assert.strictEqual(env.FARMING_TOKEN_FILE, path.join(configDir, '.session-token'));
  }

  {
    const output = execFileSync(process.execPath, ['bin/farming', '--help'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    assert(output.includes('farming daemon'));
    assert(output.includes('farming list'));
  }

  {
    const packageReleaseSource = fs.readFileSync(
      path.join(process.cwd(), 'scripts/package-release.sh'),
      'utf8',
    );
    assert(packageReleaseSource.includes('cat > "${APP_DIR}/farming"'));
    assert(packageReleaseSource.includes('FARMING_INSTALL_DIR="${FARMING_INSTALL_DIR:-${DIR}}"'));
    assert(packageReleaseSource.includes('set -- install'));
    assert(packageReleaseSource.includes('"type": "app-bundle"'));
    assert(packageReleaseSource.includes('"bundledNodeModules"'));
    assert(packageReleaseSource.includes('resolve_glibc_bundle()'));
    assert(packageReleaseSource.includes('GLIBC_SOURCE_REPO='));
    assert(packageReleaseSource.includes('vendor/glibc228-lib.tar.gz'));
    assert(packageReleaseSource.includes('"bundledGlibc": true'));
    assert(packageReleaseSource.includes('awk \'/(^|\\/)ld-2\\.28\\.so$/'));
    assert(!packageReleaseSource.includes("grep -Eq '(^|/)ld-2\\.28\\.so$'"));
  }

  {
    const releaseWorkflowSource = fs.readFileSync(
      path.join(process.cwd(), '.github/workflows/release.yml'),
      'utf8',
    );
    assert(releaseWorkflowSource.includes('node scripts/verify-release-bundle.js'));
    assert(releaseWorkflowSource.includes("const { readBundleRelease } = require('../scripts/verify-release-bundle.js');"));
    assert(releaseWorkflowSource.includes('bundledGlibc: bundle.release.bundledGlibc === true'));
    assert(releaseWorkflowSource.includes('body.replaceAll(`](./v${version}.zh_cn.md)`, `](./release-notes/v${version}.zh_cn.md)`)'));
    assert(releaseWorkflowSource.includes('body.replaceAll(`](./v${version}.md)`, `](./release-notes/v${version}.md)`)'));
  }

  {
    const installReleaseSource = fs.readFileSync(
      path.join(process.cwd(), 'scripts/install-release.sh'),
      'utf8',
    );
    assert(installReleaseSource.includes('default_glibc_root()'));
    assert(installReleaseSource.includes('Using bundled production dependencies.'));
    assert(installReleaseSource.includes('sibling glibc228/'));
    assert(installReleaseSource.includes('start|serve|daemon) start_server ;;'));
  }

  console.log('Farming 2 CLI tests passed');
}

runTests().catch(error => {
  console.error(error);
  process.exit(1);
});
