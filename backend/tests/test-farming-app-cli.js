const assert = require('assert');
const { execFileSync, fork, spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const {
  buildCleanEnvExecCommand,
  childInvocation,
  cleanupFailedDaemonStart,
  buildControlEnv,
  buildServerEnv,
  parseReviewArgs,
  parseServerArgs,
  readServerProcessIdentity,
  resolveReviewTarget,
  reviewUrl,
  serverStartTimeoutMs,
  serverStartStabilityMs,
  serverStopTimeoutMs,
  serverStateFile,
  splitControlArgs,
  stopDaemon,
  waitForDaemonStop,
} = require('../farming-app-cli');
const storageLayout = require('../storage-layout');
const {
  buildCleanEnvExecCommand: buildNativeHostCleanEnvExecCommand,
  nativeHostSpawnCommand,
} = require('../native-pty-host-client');
const {
  WorkspaceFileService,
  isPackagedRuntime,
} = require('../workspace-file-service');

function canBindPort(port) {
  return new Promise(resolve => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

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
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-review-cli.'));
    execFileSync('git', ['init', '-q', repo]);
    execFileSync('git', ['-C', repo, 'config', 'user.email', 'review@example.com']);
    execFileSync('git', ['-C', repo, 'config', 'user.name', 'Review Test']);
    fs.writeFileSync(path.join(repo, 'review.txt'), 'base\n');
    execFileSync('git', ['-C', repo, 'add', 'review.txt']);
    execFileSync('git', ['-C', repo, 'commit', '-qm', 'base']);
    fs.writeFileSync(path.join(repo, 'review.txt'), 'base\nchanged\n');

    const parsed = parseReviewArgs([repo, 'HEAD', 'now', '--no-open', '--port', '7788']);
    assert.strictEqual(parsed.noOpen, true);
    assert.strictEqual(parsed.portExplicit, true);
    assert.strictEqual(parsed.env.PORT, '7788');
    const target = resolveReviewTarget(parsed);
    assert.strictEqual(target.head, 'now');
    assert.match(target.base, /^[0-9a-f]{40}$/);
    assert.strictEqual(target.root, fs.realpathSync.native(repo));
    assert.match(reviewUrl({ FARMING_BASE_PATH: '/farm', FARMING_DISABLE_AUTH: '1', PORT: '7788' }, target), /127\.0\.0\.1:7788\/farm\/review\?base=/);
    assert.throws(() => parseReviewArgs([repo, 'now', 'HEAD']), /old revision cannot be now/);

    execFileSync('git', ['-C', repo, 'add', 'review.txt']);
    execFileSync('git', ['-C', repo, 'commit', '-qm', 'change']);
    const baseCommit = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD~1'], { encoding: 'utf8' }).trim();
    const headCommit = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const rangeTarget = resolveReviewTarget(parseReviewArgs([repo, 'HEAD~1', 'HEAD', '--no-open']));
    assert.strictEqual(rangeTarget.base, baseCommit);
    assert.strictEqual(rangeTarget.head, headCommit);
    assert.notStrictEqual(rangeTarget.head, 'now');

    execFileSync('git', ['-C', repo, 'branch', 'review-topic', 'HEAD']);
    const branchTarget = resolveReviewTarget(parseReviewArgs([
      repo,
      'HEAD~1',
      'HEAD',
      '--branch',
      'review-topic',
      '--no-open',
    ]));
    assert.strictEqual(branchTarget.branch, 'review-topic');
    assert.strictEqual(branchTarget.base, baseCommit);
    assert.strictEqual(branchTarget.head, headCommit);
  }

  {
    const env = buildServerEnv({
      FARMING_CONFIG_DIR: '/tmp/farming-default-config',
      FARMING_NODE_MAX_OLD_SPACE_SIZE: '0',
    }, {});

    assert.strictEqual(env.PORT, '6694');
    assert.strictEqual(env.FARMING_BASE_PATH, '/farming');
    assert.strictEqual(env.FARMING_CONFIG_DIR, '/tmp/farming-default-config');
    assert.strictEqual(env.FARMING_MANAGED_PACKAGE_ROOT, fs.realpathSync(path.join(__dirname, '..', '..')));
    assert.strictEqual(env.FARMING_PACKAGED_RUNTIME, undefined);
    assert(!String(env.NODE_OPTIONS || '').includes('--max-old-space-size'));
  }

  {
    assert.strictEqual(serverStartTimeoutMs({}), 30_000);
    assert.strictEqual(serverStartTimeoutMs({ FARMING_START_TIMEOUT_MS: '45000' }), 45_000);
    assert.strictEqual(serverStartTimeoutMs({ FARMING_SERVER_START_TIMEOUT_MS: '12000' }), 12_000);
    assert.strictEqual(serverStartTimeoutMs({ FARMING_START_TIMEOUT_MS: 'nope' }), 30_000);
    assert.strictEqual(serverStartStabilityMs({}), 1_500);
    assert.strictEqual(serverStartStabilityMs({ FARMING_START_STABILITY_MS: '0' }), 0);
    assert.strictEqual(serverStartStabilityMs({ FARMING_SERVER_START_STABILITY_MS: '2500' }), 2_500);
    assert.strictEqual(serverStopTimeoutMs({}), 30_000);
    assert.strictEqual(serverStopTimeoutMs({ FARMING_STOP_TIMEOUT_MS: '12000' }), 12_000);
    assert.strictEqual(serverStopTimeoutMs({ FARMING_SERVER_STOP_TIMEOUT_MS: '45000' }), 45_000);
  }

  {
    let now = 0;
    await assert.rejects(
      waitForDaemonStop(1234, 6694, {
        timeoutMs: 500,
        isRunning: () => true,
        canListenOnPort: async () => false,
        now: () => now,
        wait: async () => { now = 500; },
      }),
      /PID 1234 did not stop and release port 6694 within 500ms.*process still running.*port still in use/,
    );
  }

  {
    let now = 0;
    await assert.rejects(
      waitForDaemonStop(5678, 7788, {
        timeoutMs: 500,
        isRunning: () => false,
        canListenOnPort: async () => false,
        now: () => now,
        wait: async () => { now = 500; },
      }),
      /PID 5678 did not stop and release port 7788 within 500ms.*process exited.*port still in use/,
    );
  }

  {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-stop-daemon.'));
    const fixture = path.join(__dirname, 'fixtures', 'farming-stop-server.js');
    const child = fork(fixture, [], { detached: true, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    const childMessage = type => new Promise((resolve, reject) => {
      const onMessage = message => {
        if (message?.type !== type) return;
        cleanup();
        resolve(message);
      };
      const onExit = (code, signal) => {
        cleanup();
        reject(new Error(`stop fixture exited early (${signal || code})`));
      };
      const cleanup = () => {
        child.off('message', onMessage);
        child.off('exit', onExit);
      };
      child.on('message', onMessage);
      child.on('exit', onExit);
    });

    try {
      const listening = await childMessage('listening');
      const processIdentity = await readServerProcessIdentity(child.pid);
      assert(processIdentity, 'the detached stop fixture must expose a process identity');
      fs.writeFileSync(storageLayout.serverPidFile(configDir), String(child.pid));
      fs.writeFileSync(serverStateFile(configDir), JSON.stringify({
        pid: child.pid,
        port: listening.port,
        configDir: fs.realpathSync.native(configDir),
        processIdentity,
      }));
      const stopRequested = childMessage('stop-requested');
      let stopSettled = false;
      const stopping = stopDaemon(parseServerArgs(['stop', '--config-dir', configDir]))
        .finally(() => { stopSettled = true; });
      await stopRequested;
      await new Promise(resolve => setImmediate(resolve));
      assert.strictEqual(stopSettled, false, 'stop must wait while the old process still owns its listening port');
      assert.strictEqual(fs.existsSync(storageLayout.serverPidFile(configDir)), true);
      assert.strictEqual(fs.existsSync(serverStateFile(configDir)), true);

      child.send({ type: 'release' });
      assert.strictEqual(await stopping, 0);
      assert.strictEqual(fs.existsSync(storageLayout.serverPidFile(configDir)), false);
      assert.strictEqual(fs.existsSync(serverStateFile(configDir)), false);
      assert.strictEqual(await canBindPort(listening.port), true, 'stop must return only after the old port can be rebound');
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      fs.rmSync(configDir, { recursive: true, force: true });
    }
  }

  {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-stale-stop-daemon.'));
    const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true,
      stdio: 'ignore',
    });
    try {
      await new Promise((resolve, reject) => {
        unrelated.once('spawn', resolve);
        unrelated.once('error', reject);
      });
      const port = await freePort();
      fs.writeFileSync(storageLayout.serverPidFile(configDir), String(unrelated.pid));
      fs.writeFileSync(serverStateFile(configDir), JSON.stringify({
        pid: unrelated.pid,
        port,
        configDir: fs.realpathSync.native(configDir),
        processIdentity: {
          pid: unrelated.pid,
          processGroupId: unrelated.pid,
          startedAt: 'stale-process-start-time',
        },
      }));

      await assert.rejects(
        stopDaemon(parseServerArgs(['stop', '--config-dir', configDir])),
        /live process identity does not match the server control metadata/,
      );
      assert.doesNotThrow(() => process.kill(unrelated.pid, 0), 'stale metadata must not signal the unrelated live PID');
      assert.strictEqual(fs.existsSync(storageLayout.serverPidFile(configDir)), true);
      assert.strictEqual(fs.existsSync(serverStateFile(configDir)), true);

      fs.writeFileSync(serverStateFile(configDir), JSON.stringify({
        pid: unrelated.pid,
        port,
        configDir: fs.realpathSync.native(configDir),
      }));
      await assert.rejects(
        stopDaemon(parseServerArgs(['stop', '--config-dir', configDir])),
        /legacy server control metadata could not prove this process belongs to the config directory/,
      );
      assert.doesNotThrow(() => process.kill(unrelated.pid, 0), 'legacy metadata without identity must fail closed');
      assert.strictEqual(fs.existsSync(storageLayout.serverPidFile(configDir)), true);
      assert.strictEqual(fs.existsSync(serverStateFile(configDir)), true);
    } finally {
      try {
        process.kill(unrelated.pid, 'SIGKILL');
      } catch {
        // The test process may already have exited after a failed assertion.
      }
      fs.rmSync(configDir, { recursive: true, force: true });
    }
  }

  {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-legacy-stop-daemon.'));
    const fixture = path.join(__dirname, 'fixtures', 'farming-stop-server.js');
    const port = await freePort();
    const child = fork(fixture, [], {
      detached: true,
      env: {
        ...process.env,
        FARMING_RUN_SERVER: '1',
        FARMING_CONFIG_DIR: configDir,
        FARMING_BASE_PATH: '/farming',
        FARMING_DISABLE_AUTH: '1',
        FARMING_TEST_PORT: String(port),
        PORT: String(port),
      },
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    });
    const childMessage = type => new Promise((resolve, reject) => {
      const onMessage = message => {
        if (message?.type !== type) return;
        cleanup();
        resolve(message);
      };
      const onExit = (code, signal) => {
        cleanup();
        reject(new Error(`legacy stop fixture exited early (${signal || code})`));
      };
      const cleanup = () => {
        child.off('message', onMessage);
        child.off('exit', onExit);
      };
      child.on('message', onMessage);
      child.on('exit', onExit);
    });

    try {
      await childMessage('listening');
      fs.writeFileSync(storageLayout.serverPidFile(configDir), String(child.pid));
      fs.writeFileSync(serverStateFile(configDir), JSON.stringify({
        pid: child.pid,
        port,
        basePath: '/farming',
        configDir: fs.realpathSync.native(configDir),
        updatedAt: '2026-07-01T00:00:00.000Z',
      }));
      const stopRequested = childMessage('stop-requested');
      let stopSettled = false;
      const stopping = stopDaemon(parseServerArgs(['stop', '--config-dir', configDir]))
        .finally(() => { stopSettled = true; });
      await stopRequested;
      const migratedState = JSON.parse(fs.readFileSync(serverStateFile(configDir), 'utf8'));
      assert.strictEqual(migratedState.pid, child.pid);
      assert.strictEqual(migratedState.configDir, fs.realpathSync.native(configDir));
      assert.strictEqual(migratedState.processIdentity.pid, child.pid);
      assert.strictEqual(typeof migratedState.processIdentity.startedAt, 'string');
      assert.strictEqual(stopSettled, false, 'legacy migration must still wait for process exit and port release');
      child.send({ type: 'release' });
      assert.strictEqual(await stopping, 0);
      assert.strictEqual(fs.existsSync(storageLayout.serverPidFile(configDir)), false);
      assert.strictEqual(fs.existsSync(serverStateFile(configDir)), false);
      assert.strictEqual(await canBindPort(port), true);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      fs.rmSync(configDir, { recursive: true, force: true });
    }
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
    const invocation = childInvocation({ FARMING_NODE_BIN: '/opt/farming/runtime/bin/node' });
    assert.strictEqual(invocation.command, '/opt/farming/runtime/bin/node');
    assert.strictEqual(invocation.args.length, 1);
    assert(invocation.args[0].endsWith('/backend/farming-app-cli.js'));
  }

  {
    const invocation = childInvocation({
      FARMING_NODE_BIN: '/opt/farming/runtime/bin/node',
      FARMING_NODE_LD: '/opt/farming/glibc/lib/ld-linux-x86-64.so.2',
      FARMING_NODE_LIBRARY_PATH: '/opt/farming/glibc/lib',
    });
    assert.strictEqual(invocation.command, '/opt/farming/glibc/lib/ld-linux-x86-64.so.2');
    assert.deepStrictEqual(invocation.args.slice(0, 3), [
      '--library-path',
      '/opt/farming/glibc/lib',
      '/opt/farming/runtime/bin/node',
    ]);
    assert(invocation.args[3].endsWith('/backend/farming-app-cli.js'));
  }

  {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-failed-daemon.'));
    const deadPid = 2_147_483_647;
    fs.writeFileSync(storageLayout.serverPidFile(configDir), String(deadPid));
    fs.writeFileSync(serverStateFile(configDir), JSON.stringify({ pid: deadPid }));
    cleanupFailedDaemonStart(configDir, deadPid);
    assert.strictEqual(fs.existsSync(storageLayout.serverPidFile(configDir)), false);
    assert.strictEqual(fs.existsSync(serverStateFile(configDir)), false);
  }

  {
    const env = {
      FARMING_NODE_BIN: '/opt/farming/farming',
      FARMING_PACKAGED_RUNTIME: '1',
      FARMING_CONFIG_DIR: '/tmp/farming-config',
      SECRET_TOKEN: 'do-not-leak',
      OPENAI_API_KEY: 'do-not-leak',
    };
    const command = nativeHostSpawnCommand('/snapshot/farming/backend/native-pty-host.js', env);

    assert.strictEqual(command.command, '/opt/farming/farming');
    assert.deepStrictEqual(command.args, []);
    assert.strictEqual(command.env.FARMING_RUN_NATIVE_PTY_HOST, '1');
    assert.strictEqual(command.env.FARMING_CONFIG_DIR, '/tmp/farming-config');
    assert.strictEqual(command.env.SECRET_TOKEN, undefined);
    assert.strictEqual(command.env.OPENAI_API_KEY, undefined);
    assert(!JSON.stringify(command.env).includes('do-not-leak'));
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
    const command = nativeHostSpawnCommand('/repo/backend/native-pty-host.js', {
      FARMING_NODE_BIN: '/opt/node/bin/node',
      FARMING_NODE_LD: '/opt/glibc/lib/ld-linux-x86-64.so.2',
      FARMING_NODE_LIBRARY_PATH: '/opt/glibc/lib',
    });

    assert.strictEqual(command.command, '/opt/glibc/lib/ld-linux-x86-64.so.2');
    assert.deepStrictEqual(command.args, [
      '--library-path',
      '/opt/glibc/lib',
      '/opt/node/bin/node',
      '/repo/backend/native-pty-host.js',
    ]);
  }

  {
    const env = {
      FARMING_NODE_BIN: '/opt/node/bin/node',
      FARMING_NODE_LD: '/opt/glibc/lib/ld-linux-x86-64.so.2',
      FARMING_NODE_LIBRARY_PATH: '/opt/glibc/lib',
      FARMING_PACKAGED_RUNTIME: '1',
      FARMING_CONFIG_DIR: '/tmp/farming-config',
    };
    const command = nativeHostSpawnCommand('/snapshot/farming/backend/native-pty-host.js', env);

    assert.strictEqual(command.command, '/opt/glibc/lib/ld-linux-x86-64.so.2');
    assert.deepStrictEqual(command.args, [
      '--library-path',
      '/opt/glibc/lib',
      '/opt/node/bin/node',
    ]);
    assert.strictEqual(command.env.FARMING_NODE_LD, '/opt/glibc/lib/ld-linux-x86-64.so.2');
    assert.strictEqual(command.env.FARMING_NODE_LIBRARY_PATH, '/opt/glibc/lib');
    assert.strictEqual(command.env.FARMING_RUN_NATIVE_PTY_HOST, '1');
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
    assert(output.includes('farming review'));
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
    assert(packageReleaseSource.includes('cp "${PROJECT_ROOT}/package-lock.json"'));
    assert(packageReleaseSource.includes('linux-x64-legacy-glibc228'));
    assert(packageReleaseSource.includes('"bundledGlibcRuntime"'));
    assert(packageReleaseSource.includes('node_bin="$(type -P node || true)"'));
    assert(packageReleaseSource.includes('"${node_bin}" "${DIR}/bin/farming"'));
    assert(!packageReleaseSource.includes('"$(dirname "${loader}")" node "${DIR}/bin/farming"'));
  }

  {
    const releaseWorkflowSource = fs.readFileSync(
      path.join(process.cwd(), '.github/workflows/release.yml'),
      'utf8',
    );
    assert(releaseWorkflowSource.includes('node scripts/verify-release-bundle.js'));
    assert(releaseWorkflowSource.includes("const { readBundleRelease } = require('../scripts/verify-release-bundle.js');"));
    assert(releaseWorkflowSource.includes('bundledGlibcRuntime'));
    assert(releaseWorkflowSource.includes("(-legacy-glibc228)?\\.tar\\.gz"));
    assert(releaseWorkflowSource.includes("compatibilityProfile: bundle.release.compatibilityProfile"));
    assert(releaseWorkflowSource.includes('runner: macos-15-intel'));
    assert(releaseWorkflowSource.includes('runner: macos-15'));
    assert(releaseWorkflowSource.includes('Verify native runner architecture'));
    assert(releaseWorkflowSource.includes('farming-${FARMING_RELEASE_VERSION}-darwin-${{ matrix.arch }}.tar.gz'));
    assert(releaseWorkflowSource.includes('Smoke-test macOS app bundle'));
    assert(releaseWorkflowSource.includes('body.replaceAll(`](./v${version}.zh_cn.md)`, `](./release-notes/v${version}.zh_cn.md)`)'));
    assert(releaseWorkflowSource.includes('body.replaceAll(`](./v${version}.md)`, `](./release-notes/v${version}.md)`)'));
  }

  {
    const installReleaseSource = fs.readFileSync(
      path.join(process.cwd(), 'scripts/install-release.sh'),
      'utf8',
    );
    assert(installReleaseSource.includes('Using bundled production dependencies.'));
    assert(installReleaseSource.includes('bundled_dependencies=true'));
    assert(installReleaseSource.includes('rsync_excludes+=(--exclude \'node_modules/\')'));
    assert(installReleaseSource.includes('FARMING_USE_GLIBC_RUNTIME'));
    assert(installReleaseSource.includes('vendor/glibc228-lib.tar.gz'));
    assert(installReleaseSource.includes('start|serve|daemon) start_server ;;'));
    assert(!installReleaseSource.includes('"${STABLE_CLI_DIR}/farming" "${managed_args[@]}" || true'));
  }

  {
    const packageJson = require('../../package.json');
    const packageLock = require('../../package-lock.json');
    const notices = fs.readFileSync(path.join(process.cwd(), 'THIRD_PARTY_NOTICES.md'), 'utf8');
    const directSection = notices.match(/## Direct Runtime Dependencies\n([\s\S]*?)\n## Vendored Assets/);
    assert(directSection, 'third-party notices must include a direct runtime dependency section');
    const rows = new Map(
      [...directSection[1].matchAll(/^\| `([^`]+)` \| ([^|]+) \|/gm)]
        .map(match => [match[1], match[2].trim()])
    );
    assert.deepStrictEqual(
      [...rows.keys()].sort(),
      Object.keys(packageJson.dependencies || {}).sort(),
      'third-party notices must list every direct runtime dependency and no removed dependency'
    );
    for (const dependency of Object.keys(packageJson.dependencies || {})) {
      const locked = packageLock.packages[`node_modules/${dependency}`];
      assert(locked?.version, `missing lockfile package metadata for ${dependency}`);
      assert.strictEqual(rows.get(dependency), locked.version, `stale third-party notice version for ${dependency}`);
    }
  }

  console.log('Farming 2 CLI tests passed');
}

runTests().catch(error => {
  console.error(error);
  process.exit(1);
});
