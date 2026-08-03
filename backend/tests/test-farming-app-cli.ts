const assert = require('assert');
const { execFileSync, fork, spawn, spawnSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const YAML = require('yaml');
const {
  buildCleanEnvExecArgs,
  buildCleanEnvExecCommand,
  childInvocation,
  cleanupFailedDaemonStart,
  buildControlEnv,
  buildServerEnv,
  acquireServerConfigOwner,
  assertServerProcessClaimAvailable,
  parseReviewArgs,
  parseServerArgs,
  readServerProcessIdentity,
  releaseServerConfigOwner,
  resolveReviewTarget,
  reviewUrl,
  serverReadinessPath,
  serverStartTimeoutMs,
  serverStartStabilityMs,
  serverStopGraceMs,
  serverStopTimeoutMs,
  serverStateFile,
  splitControlArgs,
  stopDaemon,
  waitForDaemonStop,
} = require('../farming-app-cli.cjs');
const storageLayout = require('../storage-layout.cjs');
const {
  buildCleanEnvExecCommand: buildNativeHostCleanEnvExecCommand,
  nativeHostSpawnCommand,
} = require('../native-pty-host-client.cjs');
const {
  WorkspaceFileService,
  isPackagedRuntime,
} = require('../workspace-file-service.cjs');

type ErrorWithCode = Error & { code?: string };
type PackagedProcess = NodeJS.Process & { pkg?: object };

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

function waitForOutput(child, pattern, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`process ${child.pid} did not produce ${pattern} within ${timeoutMs}ms: ${output}`));
    }, timeoutMs);
    const onData = chunk => {
      output += String(chunk);
      if (!pattern.test(output)) return;
      cleanup();
      resolve(output);
    };
    const onExit = (code, signal) => {
      cleanup();
      reject(new Error(`process ${child.pid} exited before ${pattern} (${signal || code}): ${output}`));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout?.off('data', onData);
      child.stderr?.off('data', onData);
      child.off('exit', onExit);
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('exit', onExit);
  });
}

function waitForCondition(predicate, description, timeoutMs = 15_000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const value = predicate();
      if (value) {
        resolve(value);
        return;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        reject(new Error(`timed out waiting for ${description}`));
        return;
      }
      setTimeout(tick, 25);
    };
    tick();
  });
}

async function stopTestProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.kill('SIGKILL');
  await exited;
}

function spawnConfigOwner(configDir) {
  return spawn(process.execPath, ['-e', [
    "const { acquireServerConfigOwner } = require('./backend/farming-app-cli.cjs');",
    'acquireServerConfigOwner(process.env.FARMING_CONFIG_DIR);',
    "process.stdout.write('owner-ready\\n');",
    'setInterval(() => {}, 1000);',
  ].join(' ')], {
    cwd: process.cwd(),
    env: { ...process.env, FARMING_CONFIG_DIR: configDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function spawnRawServer(configDir, port) {
  return spawn(process.execPath, ['backend/farming-app-cli.cjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      FARMING_CONFIG_DIR: configDir,
      FARMING_DISABLE_AUTH: '1',
      FARMING_RUN_SERVER: '1',
      FARMING_SESSION_ENGINE: 'local',
      FARMING_SKIP_RUNTIME_PREPARE: '1',
      NODE_ENV: 'test',
      PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function runTests() {
  assert.strictEqual(
    serverReadinessPath({ FARMING_BASE_PATH: '/farming' }, true),
    '/farming/api/auth/status',
  );
  assert.strictEqual(
    serverReadinessPath({ FARMING_BASE_PATH: '/farming' }, false, 'token with spaces'),
    '/farming/api/executables?token=token%20with%20spaces',
    'authenticated daemon readiness must not depend on a built frontend entry page',
  );

  {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-direct-server-rejected.'));
    try {
      const direct = spawnSync(process.execPath, ['backend/server.cjs'], {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          ...process.env,
          FARMING_CONFIG_DIR: configDir,
          NODE_ENV: '',
        },
      });
      assert.strictEqual(direct.status, 1);
      assert.match(direct.stderr, /Direct backend\/server\.cjs startup is unsupported/);
      assert.deepStrictEqual(
        fs.readdirSync(configDir),
        [],
        'an unsupported direct Server startup must fail before initializing Config-owned state',
      );
    } finally {
      fs.rmSync(configDir, { recursive: true, force: true });
    }
  }

  {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-server-claim.'));
    const owner = spawnConfigOwner(configDir);
    try {
      await waitForOutput(owner, /owner-ready/);
      const before = fs.readdirSync(configDir).sort();
      assert.throws(
        () => acquireServerConfigOwner(configDir),
        new RegExp(`already owned by live Server PID ${owner.pid}`),
      );
      const duplicate = spawnSync(process.execPath, ['backend/farming-app-cli.cjs'], {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          ...process.env,
          FARMING_CONFIG_DIR: configDir,
          FARMING_DISABLE_AUTH: '1',
          FARMING_RUN_SERVER: '1',
          NODE_ENV: 'test',
          PORT: String(await freePort()),
        },
      });
      assert.strictEqual(duplicate.status, 1);
      assert.match(duplicate.stderr, /already owned by live Server PID/);
      assert.deepStrictEqual(
        fs.readdirSync(configDir).sort(),
        before,
        'a rejected duplicate Server must not initialize AgentManager-owned config state',
      );
      assert.strictEqual(
        fs.existsSync(storageLayout.nativePtyControllerGenerationFile(configDir)),
        false,
        'a rejected duplicate Server must not initialize the native PTY controller',
      );
    } finally {
      await stopTestProcess(owner);
      fs.rmSync(configDir, { recursive: true, force: true });
    }
  }

  {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-server-release.'));
    try {
      const identity = acquireServerConfigOwner(configDir);
      const owner = JSON.parse(fs.readFileSync(storageLayout.serverOwnerFile(configDir), 'utf8'));
      releaseServerConfigOwner(configDir, process.pid, identity);
      assert.strictEqual(fs.existsSync(storageLayout.serverOwnerLockDir(configDir)), false);
      assert.strictEqual(
        fs.existsSync(`${storageLayout.serverOwnerLockDir(configDir)}.stale-${owner.claimId}`),
        true,
        'release must fence the exact claim instead of deleting a potentially replaced owner path',
      );
    } finally {
      fs.rmSync(configDir, { recursive: true, force: true });
    }
  }

  {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-server-stale-owner.'));
    const firstOwner = spawnConfigOwner(configDir);
    let replacementOwner;
    try {
      await waitForOutput(firstOwner, /owner-ready/);
      const firstRecord = JSON.parse(fs.readFileSync(storageLayout.serverOwnerFile(configDir), 'utf8'));
      await stopTestProcess(firstOwner);

      replacementOwner = spawnConfigOwner(configDir);
      await waitForOutput(replacementOwner, /owner-ready/);
      const replacementRecord = JSON.parse(fs.readFileSync(storageLayout.serverOwnerFile(configDir), 'utf8'));
      assert.notStrictEqual(replacementRecord.claimId, firstRecord.claimId);
      assert.strictEqual(replacementRecord.pid, replacementOwner.pid);
      assert.strictEqual(
        fs.existsSync(`${storageLayout.serverOwnerLockDir(configDir)}.stale-${firstRecord.claimId}`),
        true,
        'a precisely stale owner must be fenced before replacement',
      );
    } finally {
      await stopTestProcess(firstOwner);
      if (replacementOwner) await stopTestProcess(replacementOwner);
      fs.rmSync(configDir, { recursive: true, force: true });
    }
  }

  {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-server-unknown-owner.'));
    try {
      fs.mkdirSync(storageLayout.serverOwnerLockDir(configDir));
      assert.throws(
        () => acquireServerConfigOwner(configDir),
        /owner lock has no verifiable process identity/,
      );
      assert.strictEqual(
        fs.existsSync(storageLayout.serverOwnerLockDir(configDir)),
        true,
        'an owner with uncertain identity must fail closed instead of being age-reclaimed',
      );
    } finally {
      fs.rmSync(configDir, { recursive: true, force: true });
    }
  }

  {
    const parentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-server-symlink-owner.'));
    const configDir = path.join(parentDir, 'config');
    const aliasDir = path.join(parentDir, 'config-alias');
    fs.mkdirSync(configDir);
    fs.symlinkSync(configDir, aliasDir, process.platform === 'win32' ? 'junction' : 'dir');
    const owner = spawnConfigOwner(configDir);
    try {
      await waitForOutput(owner, /owner-ready/);
      assert.throws(
        () => acquireServerConfigOwner(aliasDir),
        new RegExp(`already owned by live Server PID ${owner.pid}`),
      );
    } finally {
      await stopTestProcess(owner);
      fs.rmSync(parentDir, { recursive: true, force: true });
    }
  }

  {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-server-concurrent.'));
    const firstPort = await freePort();
    let secondPort = await freePort();
    while (secondPort === firstPort) secondPort = await freePort();
    const first = spawnRawServer(configDir, firstPort);
    const second = spawnRawServer(configDir, secondPort);
    let firstOutput = '';
    let secondOutput = '';
    first.stdout.on('data', chunk => { firstOutput += String(chunk); });
    first.stderr.on('data', chunk => { firstOutput += String(chunk); });
    second.stdout.on('data', chunk => { secondOutput += String(chunk); });
    second.stderr.on('data', chunk => { secondOutput += String(chunk); });
    try {
      await waitForCondition(
        () => [first, second].filter(child => child.exitCode !== null || child.signalCode !== null).length === 1,
        'exactly one concurrent Server startup to be rejected',
      );
      await waitForCondition(() => {
        try {
          return JSON.parse(fs.readFileSync(serverStateFile(configDir), 'utf8')).phase === 'running';
        } catch {
          return false;
        }
      }, 'the winning concurrent Server to enter running state');

      const winner = first.exitCode === null && first.signalCode === null ? first : second;
      const loser = winner === first ? second : first;
      const loserOutput = loser === first ? firstOutput : secondOutput;
      const state = JSON.parse(fs.readFileSync(serverStateFile(configDir), 'utf8'));
      const owner = JSON.parse(fs.readFileSync(storageLayout.serverOwnerFile(configDir), 'utf8'));
      assert.strictEqual(loser.exitCode, 1);
      assert.match(loserOutput, /already owned by live Server PID/);
      assert.strictEqual(state.pid, winner.pid);
      assert.strictEqual(owner.pid, winner.pid);
      assert.strictEqual(state.port, winner === first ? firstPort : secondPort);
    } finally {
      await stopTestProcess(first);
      await stopTestProcess(second);
      fs.rmSync(configDir, { recursive: true, force: true });
    }
  }

  {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-server-legacy-claim.'));
    const owner = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    try {
      await new Promise((resolve, reject) => {
        owner.once('spawn', resolve);
        owner.once('error', reject);
      });
      fs.writeFileSync(storageLayout.serverPidFile(configDir), String(owner.pid));
      assert.throws(
        () => assertServerProcessClaimAvailable(configDir),
        new RegExp(`already owned by live Server PID ${owner.pid}`),
      );
      assert.doesNotThrow(() => assertServerProcessClaimAvailable(configDir, owner.pid));
    } finally {
      await stopTestProcess(owner);
      fs.rmSync(configDir, { recursive: true, force: true });
    }
  }

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
    const previousTimeZone = process.env.TZ;
    const previousLocale = process.env.LC_ALL;
    try {
      process.env.TZ = 'UTC';
      process.env.LC_ALL = 'C';
      const utcIdentity = await readServerProcessIdentity(process.pid);
      process.env.TZ = 'Asia/Shanghai';
      process.env.LC_ALL = 'zh_CN.UTF-8';
      const localizedIdentity = await readServerProcessIdentity(process.pid);
      assert.deepStrictEqual(
        localizedIdentity,
        utcIdentity,
        'server process identity must not depend on the stop caller time zone or locale',
      );
    } finally {
      if (previousTimeZone === undefined) delete process.env.TZ;
      else process.env.TZ = previousTimeZone;
      if (previousLocale === undefined) delete process.env.LC_ALL;
      else process.env.LC_ALL = previousLocale;
    }
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
    assert.strictEqual(serverStopGraceMs({}), 5_000);
    assert.strictEqual(serverStopGraceMs({ FARMING_STOP_GRACE_MS: '25' }), 25);
    assert.strictEqual(serverStopGraceMs({ FARMING_SERVER_STOP_GRACE_MS: '45000' }), 30_000);
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
    const fixture = path.join(__dirname, 'fixtures', 'farming-stop-server.ts');
    const child = fork(fixture, [], {
      detached: true,
      execArgv: ['--import', require.resolve('tsx')],
      env: {
        ...process.env,
        FARMING_TEST_IGNORE_SIGTERM: '1',
      },
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    });
    const childMessage = (type: string) => new Promise<{ type: string; port: number }>((resolve, reject) => {
      const onMessage = (message: unknown) => {
        if (
          !message
          || typeof message !== 'object'
          || !('type' in message)
          || message.type !== type
          || !('port' in message)
          || typeof message.port !== 'number'
        ) return;
        cleanup();
        resolve({ type, port: message.port });
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

      const originalKill = process.kill;
      const stopSignals: NodeJS.Signals[] = [];
      process.kill = (pid, signal) => {
        if (pid === child.pid && signal) stopSignals.push(signal);
        if (pid === child.pid && signal === 'SIGKILL') {
          const error: ErrorWithCode = new Error('Operation not permitted');
          error.code = 'EPERM';
          throw error;
        }
        return originalKill(pid, signal);
      };
      try {
        const parsed = parseServerArgs(['stop', '--config-dir', configDir]);
        parsed.env.FARMING_STOP_GRACE_MS = '25';
        await assert.rejects(
          stopDaemon(parsed),
          /lacks permission.*operating-system user that owns the process/s,
        );
      } finally {
        process.kill = originalKill;
      }
      assert.deepStrictEqual(stopSignals, ['SIGTERM', 'SIGKILL']);
      assert.doesNotThrow(() => process.kill(child.pid, 0));
      assert.strictEqual(fs.existsSync(storageLayout.serverPidFile(configDir)), true);
      assert.strictEqual(fs.existsSync(serverStateFile(configDir)), true);

      const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
      const parsed = parseServerArgs(['stop', '--config-dir', configDir]);
      parsed.env.FARMING_STOP_GRACE_MS = '25';
      assert.strictEqual(await stopDaemon(parsed), 0);
      assert.deepStrictEqual(await exited, { code: null, signal: 'SIGKILL' });
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
    const port = await freePort();
    const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true,
      env: {
        ...process.env,
        FARMING_RUN_SERVER: '1',
        FARMING_CONFIG_DIR: configDir,
        PORT: String(port),
      },
      stdio: 'ignore',
    });
    try {
      await new Promise((resolve, reject) => {
        unrelated.once('spawn', resolve);
        unrelated.once('error', reject);
      });
      const unrelatedIdentity = await readServerProcessIdentity(unrelated.pid);
      assert(unrelatedIdentity, 'the detached stale process must expose a process identity');
      fs.writeFileSync(storageLayout.serverPidFile(configDir), String(unrelated.pid));
      fs.writeFileSync(serverStateFile(configDir), JSON.stringify({
        pid: unrelated.pid,
        port,
        configDir: fs.realpathSync.native(configDir),
        processIdentity: {
          ...unrelatedIdentity,
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
        /legacy process does not own listening port/,
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
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-starting-stop-daemon.'));
    const port = await freePort();
    const starting = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true,
      stdio: 'ignore',
    });
    try {
      await new Promise((resolve, reject) => {
        starting.once('spawn', resolve);
        starting.once('error', reject);
      });
      const processIdentity = await readServerProcessIdentity(starting.pid);
      fs.writeFileSync(storageLayout.serverPidFile(configDir), String(starting.pid));
      fs.writeFileSync(serverStateFile(configDir), JSON.stringify({
        pid: starting.pid,
        port,
        configDir: fs.realpathSync.native(configDir),
        processIdentity,
        phase: 'starting',
      }));
      const exited = new Promise(resolve => starting.once('exit', (code, signal) => resolve({ code, signal })));
      assert.strictEqual(await stopDaemon(parseServerArgs(['stop', '--config-dir', configDir])), 0);
      assert.deepStrictEqual(await exited, { code: null, signal: 'SIGTERM' });
    } finally {
      if (starting.exitCode === null && starting.signalCode === null) starting.kill('SIGKILL');
      fs.rmSync(configDir, { recursive: true, force: true });
    }
  }

  {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-legacy-stop-daemon.'));
    const configAlias = `${configDir}-alias`;
    fs.symlinkSync(configDir, configAlias, process.platform === 'win32' ? 'junction' : 'dir');
    const fixture = path.join(__dirname, 'fixtures', 'farming-stop-server.ts');
    const port = await freePort();
    const token = 'legacy-config-token-019f98f3';
    const legacyWorkspace = '/project/workspace-not-config-dir';
    assert.notStrictEqual(legacyWorkspace, fs.realpathSync.native(configDir));
    fs.writeFileSync(storageLayout.sessionTokenFile(configDir), token, { mode: 0o600 });
    const child = fork(fixture, [], {
      detached: true,
      execArgv: ['--import', require.resolve('tsx')],
      env: {
        ...process.env,
        FARMING_RUN_SERVER: '1',
        FARMING_CONFIG_DIR: configAlias,
        FARMING_BASE_PATH: '/farming',
        FARMING_TEST_PORT: String(port),
        FARMING_TEST_TOKEN: token,
        FARMING_TEST_WORKSPACE: legacyWorkspace,
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
      fs.writeFileSync(storageLayout.sessionTokenFile(configDir), 'wrong-config-token', { mode: 0o600 });
      await assert.rejects(
        stopDaemon(parseServerArgs(['stop', '--config-dir', configDir])),
        /identity probe returned HTTP 401/,
      );
      assert.doesNotThrow(() => process.kill(child.pid, 0), 'a mismatched config token must not signal the legacy server PID');
      assert.strictEqual(JSON.parse(fs.readFileSync(serverStateFile(configDir), 'utf8')).processIdentity, undefined);
      fs.writeFileSync(storageLayout.sessionTokenFile(configDir), token, { mode: 0o600 });

      const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
      assert.strictEqual(await stopDaemon(parseServerArgs(['stop', '--config-dir', configDir])), 0);
      assert.deepStrictEqual(await exited, { code: null, signal: 'SIGTERM' });
      assert.strictEqual(fs.existsSync(storageLayout.serverPidFile(configDir)), false);
      assert.strictEqual(fs.existsSync(serverStateFile(configDir)), false);
      assert.strictEqual(await canBindPort(port), true);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      fs.rmSync(configAlias, { force: true });
      fs.rmSync(configDir, { recursive: true, force: true });
    }
  }

  {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-legacy-no-auth-stop-daemon.'));
    const fixture = path.join(__dirname, 'fixtures', 'farming-stop-server.ts');
    const port = await freePort();
    fs.writeFileSync(storageLayout.sessionTokenFile(configDir), 'stale-token-from-an-authenticated-launch', { mode: 0o600 });
    const child = fork(fixture, [], {
      detached: true,
      execArgv: ['--import', require.resolve('tsx')],
      env: {
        ...process.env,
        FARMING_RUN_SERVER: '1',
        FARMING_CONFIG_DIR: configDir,
        FARMING_BASE_PATH: '/farming',
        FARMING_DISABLE_AUTH: '1',
        FARMING_TEST_PORT: String(port),
        FARMING_TEST_REJECT_COOKIE: '1',
        FARMING_TEST_WORKSPACE: '/legacy/no-auth/project-workspace',
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
        reject(new Error(`legacy no-auth stop fixture exited early (${signal || code})`));
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
      assert.strictEqual(fs.existsSync(storageLayout.sessionTokenFile(configDir)), true);
      fs.writeFileSync(storageLayout.serverPidFile(configDir), String(child.pid));
      fs.writeFileSync(serverStateFile(configDir), JSON.stringify({
        pid: child.pid,
        port,
        basePath: '/farming',
        configDir: fs.realpathSync.native(configDir),
        updatedAt: '2026-07-01T00:00:00.000Z',
      }));
      const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
      assert.strictEqual(await stopDaemon(parseServerArgs(['stop', '--config-dir', configDir])), 0);
      assert.deepStrictEqual(await exited, { code: null, signal: 'SIGTERM' });
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
    const args = buildCleanEnvExecArgs({
      PORT: '6694',
      FARMING_CONFIG_DIR: "/tmp/farming's config",
      'bad-key': 'skip',
    }, '/tmp/farming bin/farming', ['--']);

    assert.deepStrictEqual(args, [
      '-i',
      'PORT=6694',
      "FARMING_CONFIG_DIR=/tmp/farming's config",
      '/tmp/farming bin/farming',
      '--',
    ]);

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
    assert(
      invocation.args[0].endsWith('/backend/farming-app-cli.cts'),
      'tsx should exercise the TypeScript source entry during this test',
    );
    const nativeInvocation = JSON.parse(execFileSync(process.execPath, [
      '-e',
      "const { childInvocation } = require('./backend/farming-app-cli.cjs'); process.stdout.write(JSON.stringify(childInvocation({ FARMING_NODE_BIN: '/opt/farming/runtime/bin/node' })));",
    ], { cwd: path.join(__dirname, '..', '..'), encoding: 'utf8' }));
    assert.strictEqual(nativeInvocation.command, '/opt/farming/runtime/bin/node');
    assert.deepStrictEqual(nativeInvocation.args, [
      path.join(__dirname, '..', 'farming-app-cli.cjs'),
    ]);
  }

  {
    const packagedProcess = process as PackagedProcess;
    const previousPkg = packagedProcess.pkg;
    packagedProcess.pkg = {};
    try {
      const invocation = childInvocation({
        FARMING_RUN_SERVER: '1',
        PORT: '6694',
      });
      assert.strictEqual(invocation.command, '/usr/bin/env');
      assert.deepStrictEqual(invocation.args, [
        '-i',
        'FARMING_RUN_SERVER=1',
        'PORT=6694',
        process.execPath,
      ]);
    } finally {
      if (previousPkg === undefined) delete packagedProcess.pkg;
      else packagedProcess.pkg = previousPkg;
    }
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
    assert(invocation.args[3].endsWith('/backend/farming-app-cli.cts'));
    const nativeInvocation = JSON.parse(execFileSync(process.execPath, [
      '-e',
      "const { childInvocation } = require('./backend/farming-app-cli.cjs'); process.stdout.write(JSON.stringify(childInvocation({ FARMING_NODE_BIN: '/opt/farming/runtime/bin/node', FARMING_NODE_LD: '/opt/farming/glibc/lib/ld-linux-x86-64.so.2', FARMING_NODE_LIBRARY_PATH: '/opt/farming/glibc/lib' })));",
    ], { cwd: path.join(__dirname, '..', '..'), encoding: 'utf8' }));
    assert.strictEqual(nativeInvocation.command, '/opt/farming/glibc/lib/ld-linux-x86-64.so.2');
    assert.deepStrictEqual(nativeInvocation.args, [
      '--library-path',
      '/opt/farming/glibc/lib',
      '/opt/farming/runtime/bin/node',
      path.join(__dirname, '..', 'farming-app-cli.cjs'),
    ]);
  }

  {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-failed-daemon.'));
    const deadPid = 2_147_483_647;
    fs.writeFileSync(storageLayout.serverPidFile(configDir), String(deadPid));
    fs.writeFileSync(serverStateFile(configDir), JSON.stringify({ pid: deadPid }));
    await cleanupFailedDaemonStart(configDir, deadPid);
    assert.strictEqual(fs.existsSync(storageLayout.serverPidFile(configDir)), false);
    assert.strictEqual(fs.existsSync(serverStateFile(configDir)), false);
  }

  {
    const env: NodeJS.ProcessEnv = {
      FARMING_NODE_BIN: '/opt/farming/farming',
      FARMING_PACKAGED_RUNTIME: '1',
      FARMING_CONFIG_DIR: '/tmp/farming-config',
      SECRET_TOKEN: 'do-not-leak',
      OPENAI_API_KEY: 'do-not-leak',
    };
    const command = nativeHostSpawnCommand('/snapshot/farming/backend/native-pty-host.cjs', env);

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
    const command = nativeHostSpawnCommand('/repo/backend/native-pty-host.cjs', {
      FARMING_NODE_BIN: '/usr/bin/node',
    });

    assert.strictEqual(command.command, '/usr/bin/node');
    assert.deepStrictEqual(command.args, ['/repo/backend/native-pty-host.cjs']);
  }

  {
    const command = nativeHostSpawnCommand('/repo/backend/native-pty-host.cjs', {
      FARMING_NODE_BIN: '/opt/node/bin/node',
      FARMING_NODE_LD: '/opt/glibc/lib/ld-linux-x86-64.so.2',
      FARMING_NODE_LIBRARY_PATH: '/opt/glibc/lib',
    });

    assert.strictEqual(command.command, '/opt/glibc/lib/ld-linux-x86-64.so.2');
    assert.deepStrictEqual(command.args, [
      '--library-path',
      '/opt/glibc/lib',
      '/opt/node/bin/node',
      '/repo/backend/native-pty-host.cjs',
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
    const command = nativeHostSpawnCommand('/snapshot/farming/backend/native-pty-host.cjs', env);

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
    const output = execFileSync(process.execPath, ['backend/farming-app-cli.cjs', '--help'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    assert(output.includes('farming daemon'));
    assert(output.includes('farming list'));
    assert(output.includes('farming title'));
    assert(output.includes('farming review'));
  }

  {
    const result = spawnSync(process.execPath, ['backend/farming-app-cli.cjs', 'title'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    assert.strictEqual(result.status, 1);
    assert.match(result.stderr, /title requires a concise title/);
    assert.doesNotMatch(result.stderr, /Unknown option: title/);
  }

  {
    const output = execFileSync(process.execPath, ['backend/farming-app-cli.cjs', 'computer', '--help'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 5_000,
      env: {
        ...process.env,
        FARMING_RUN_SERVER: '1',
        FARMING_RUN_NATIVE_PTY_HOST: '1',
      },
    });
    assert(output.includes('farming computer'));
    assert(output.includes('mcp'));
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
    assert(releaseWorkflowSource.includes('node --import tsx scripts/verify-release-bundle.ts'));
    assert(releaseWorkflowSource.includes("const { readBundleRelease } = require('../scripts/verify-release-bundle.ts');"));
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
    assert(releaseWorkflowSource.includes('node scripts/verify-release-notes.mjs "${RELEASE_VERSION}"'));
    assert(releaseWorkflowSource.includes('RELEASE_CODENAME: ${{ steps.notes.outputs.codename }}'));
    assert(releaseWorkflowSource.includes('--title "Farming ${RELEASE_VERSION} · ${RELEASE_CODENAME}"'));
    assert(releaseWorkflowSource.includes('workflow_dispatch:'));
    assert(!releaseWorkflowSource.includes("push:\n    tags:\n      - 'v*'"));
    const npmPublishJob = releaseWorkflowSource.slice(
      releaseWorkflowSource.indexOf('  publish-npm:'),
      releaseWorkflowSource.indexOf('  publish-github-release:'),
    );
    const stagedReleaseJob = releaseWorkflowSource.slice(
      releaseWorkflowSource.indexOf('  stage-release:'),
      releaseWorkflowSource.indexOf('  publish-npm:'),
    );
    assert(npmPublishJob.includes('      - build-linux'));
    assert(npmPublishJob.includes('      - build-macos'));
    assert(stagedReleaseJob.includes('      - publish-npm'));
    assert(stagedReleaseJob.includes('--draft'));
    assert(stagedReleaseJob.includes('git push origin "refs/tags/${RELEASE_TAG}"'));
    assert(releaseWorkflowSource.includes('gh release edit "${tag}" --repo "${GITHUB_REPOSITORY}" --draft=false'));
    const releaseWorkflow = YAML.parse(releaseWorkflowSource);
    assert.deepStrictEqual(releaseWorkflow.permissions, { actions: 'read', contents: 'write' });
    const releaseCiGate = releaseWorkflow.jobs.preflight.steps.find(
      step => step.name === 'Require successful CI for candidate revision',
    );
    assert(releaseCiGate, 'release preflight must require CI for the exact candidate revision');
    assert.strictEqual(releaseCiGate.env.GH_TOKEN, '${{ github.token }}');
    assert(
      releaseCiGate.run.includes('--workflow ci.yml')
        && releaseCiGate.run.includes('--commit "${GITHUB_SHA}"')
        && releaseCiGate.run.includes('gh run watch "${ci_run_id}"')
        && releaseCiGate.run.includes('--exit-status'),
      'release preflight must find and fail closed on the candidate revision CI run',
    );
    assert.deepStrictEqual(releaseWorkflow.jobs['publish-npm'].needs, ['build-linux', 'build-macos']);
    assert.deepStrictEqual(releaseWorkflow.jobs['stage-release'].needs, ['publish-npm']);
    assert.deepStrictEqual(releaseWorkflow.jobs['publish-github-release'].needs, ['stage-release']);
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
