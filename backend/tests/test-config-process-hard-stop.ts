const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const {
  discoverLegacyConfigProcesses,
  hardStopConfigProcesses,
  killOwnedProcessGroup,
  registerConfigProcessGroup,
} = require('../config-process-ownership.cjs');
const { configInstanceFingerprint } = require('../config-instance.cjs');
const { acpRuntimeHostSocketPath } = require('../acp-runtime-host-path.cjs');
const { nativePtyHostSocketPath } = require('../native-pty-host-path.cjs');

function writeProcFixture(procRoot, pid, options) {
  const directory = path.join(procRoot, String(pid));
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'environ'), `${Object.entries(options.env)
    .map(([key, value]) => `${key}=${value}`)
    .join('\0')}\0`);
  fs.writeFileSync(path.join(directory, 'cmdline'), `${options.args.join('\0')}\0`);
  fs.writeFileSync(path.join(directory, 'status'), [
    'Name:\ttest',
    `Pid:\t${pid}`,
    `PPid:\t${options.parentPid ?? 1}`,
    `Uid:\t${options.uid}\t${options.uid}\t${options.uid}\t${options.uid}`,
    '',
  ].join('\n'));
  fs.writeFileSync(
    path.join(directory, 'stat'),
    `${pid} (test carrier) S ${options.parentPid ?? 1} ${options.processGroupId ?? pid} ${options.processGroupId ?? pid} 0 -1 0\n`,
  );
}

async function run() {
  {
    const expected = {
      pid: 30001,
      processGroupId: 30001,
      startedAt: 'exact-terminal-owner',
    };
    const signals = [];
    assert.throws(
      () => killOwnedProcessGroup({ ...expected, processGroupId: 30002 }),
      /process-group leader identity/,
    );
    assert.deepStrictEqual(killOwnedProcessGroup(expected, {
      readProcessIdentity: () => expected,
      signalProcessGroup(processGroupId, signal) {
        signals.push({ processGroupId, signal });
      },
    }), { killed: true });
    assert.deepStrictEqual(signals, [{ processGroupId: 30001, signal: 'SIGKILL' }]);

    signals.length = 0;
    assert.deepStrictEqual(killOwnedProcessGroup(expected, {
      readProcessIdentity: () => ({ ...expected, startedAt: 'reused-pid' }),
      signalProcessGroup(processGroupId, signal) {
        signals.push({ processGroupId, signal });
      },
    }), { killed: false, identityMismatch: true });
    assert.deepStrictEqual(signals, [], 'a reused Terminal process-group leader must not be signalled');

    assert.deepStrictEqual(killOwnedProcessGroup(expected, {
      readProcessIdentity: () => null,
      processExists: () => true,
      signalProcessGroup() {
        throw new Error('unreachable');
      },
    }), { killed: false, identityUnavailable: true });

    assert.deepStrictEqual(killOwnedProcessGroup(expected, {
      readProcessIdentity: () => null,
      processExists: () => false,
      signalProcessGroup() {
        throw Object.assign(new Error('missing group'), { code: 'ESRCH' });
      },
    }), { killed: false, alreadyExited: true });

    const zombieDescendantSignals = [];
    const zombieDescendants = await hardStopConfigProcesses('/tmp/farming-zombie-descendant-config', {
      readProcessIdentity: () => expected,
      isProcessZombie: () => true,
      inspectProcessGroup: () => 'live',
      processExists: () => true,
      signalProcessGroup(processGroupId, signal) {
        zombieDescendantSignals.push({ processGroupId, signal });
      },
      waitForProcessGroupExit: async () => true,
      discoverLegacyProcesses: async () => [{
        ...expected,
        role: 'terminal',
        configInstanceFingerprint: configInstanceFingerprint('/tmp/farming-zombie-descendant-config'),
      }],
    });
    assert.deepStrictEqual(zombieDescendantSignals, [{ processGroupId: 30001, signal: 'SIGKILL' }]);
    assert.deepStrictEqual(zombieDescendants, { stopped: 1, refused: 0 });

    const orphanDescendantSignals = [];
    const orphanDescendants = await hardStopConfigProcesses('/tmp/farming-orphan-descendant-config', {
      readProcessIdentity: () => null,
      inspectProcessGroup: () => 'live',
      processExists: () => false,
      signalProcessGroup(processGroupId, signal) {
        orphanDescendantSignals.push({ processGroupId, signal });
      },
      waitForProcessGroupExit: async () => true,
      discoverLegacyProcesses: async () => [{
        ...expected,
        role: 'terminal',
        configInstanceFingerprint: configInstanceFingerprint('/tmp/farming-orphan-descendant-config'),
      }],
    });
    assert.deepStrictEqual(orphanDescendantSignals, [{ processGroupId: 30001, signal: 'SIGKILL' }]);
    assert.deepStrictEqual(orphanDescendants, { stopped: 1, refused: 0 });
  }

  {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-legacy-proc-config.'));
    const otherConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-legacy-proc-other.'));
    const procRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-legacy-proc-root.'));
    const packageRoot = path.join(configDir, 'images', 'legacy-image');
    const browserPath = path.join(configDir, 'runtimes', 'agentBrowser', '0.32.3', 'linux-x64', 'agent-browser');
    const identities = new Map();
    const add = (pid, options) => {
      writeProcFixture(procRoot, pid, options);
      identities.set(pid, {
        pid,
        processGroupId: options.processGroupId ?? pid,
        startedAt: `identity-${pid}`,
      });
    };
    try {
      add(31001, {
        uid: 505,
        env: {
          FARMING_CONFIG_DIR: configDir,
          FARMING_ACTIVE_PACKAGE_ROOT: packageRoot,
        },
        args: [
          path.join(packageRoot, '.farming-glibc', 'lib', 'ld-2.28.so'),
          '--library-path', path.join(packageRoot, '.farming-glibc', 'lib'),
          '/usr/local/bin/node',
          path.join(packageRoot, 'backend', 'acp-runtime-host-process.cjs'),
        ],
      });
      add(31002, {
        uid: 505,
        env: {
          FARMING_CONFIG_DIR: configDir,
          FARMING_AGENT_BROWSER_BIN: browserPath,
        },
        args: [browserPath],
      });
      add(31003, {
        uid: 505,
        env: {
          FARMING_CONFIG_DIR: otherConfigDir,
          FARMING_AGENT_BROWSER_BIN: browserPath,
        },
        args: [browserPath],
      });
      add(31004, {
        uid: 506,
        env: {
          FARMING_CONFIG_DIR: configDir,
          FARMING_ACTIVE_PACKAGE_ROOT: packageRoot,
        },
        args: ['/usr/local/bin/node', path.join(packageRoot, 'backend', 'acp-runtime-host-process.cjs')],
      });
      add(31005, {
        uid: 505,
        processGroupId: 31001,
        env: {
          FARMING_CONFIG_DIR: configDir,
          FARMING_ACTIVE_PACKAGE_ROOT: packageRoot,
        },
        args: ['/usr/local/bin/node', path.join(packageRoot, 'backend', 'acp-runtime-host-process.cjs')],
      });
      const outsideBrowser = path.join(os.tmpdir(), 'agent-browser');
      add(31006, {
        uid: 505,
        env: {
          FARMING_CONFIG_DIR: configDir,
          FARMING_AGENT_BROWSER_BIN: outsideBrowser,
        },
        args: [outsideBrowser],
      });
      add(31007, {
        uid: 505,
        env: {
          FARMING_CONFIG_DIR: configDir,
          FARMING_ACTIVE_PACKAGE_ROOT: packageRoot,
        },
        args: ['/usr/local/bin/node', path.join(configDir, 'spoof', 'backend', 'acp-runtime-host-process.cjs')],
      });

      const discovered = await discoverLegacyConfigProcesses(configDir, {
        currentUid: 505,
        procRoot,
        readProcessIdentity: pid => identities.get(pid) || null,
      });
      assert.deepStrictEqual(
        discovered.map(record => [record.pid, record.role]),
        [
          [31001, 'legacy-acp-runtime-host'],
          [31002, 'legacy-browser'],
        ],
        'legacy discovery must require exact Config, uid, group leadership, and Farming carrier paths',
      );

      identities.set(31001, { pid: 31001, processGroupId: 31001, startedAt: 'reused-pid' });
      const signals = [];
      const stop = await hardStopConfigProcesses(configDir, {
        discoverLegacyProcesses: async () => discovered,
        readProcessIdentity: pid => identities.get(pid) || null,
        signalProcessGroup(processGroupId, signal) {
          signals.push({ processGroupId, signal });
          identities.delete(processGroupId);
        },
        waitForProcessGroupExit: async () => true,
      });
      assert.deepStrictEqual(signals, [{ processGroupId: 31002, signal: 'SIGKILL' }]);
      assert.strictEqual(stop.refused, 1, 'legacy PID reuse must fail closed before signaling');
    } finally {
      fs.rmSync(configDir, { recursive: true, force: true });
      fs.rmSync(otherConfigDir, { recursive: true, force: true });
      fs.rmSync(procRoot, { recursive: true, force: true });
    }
  }

  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-config-hard-stop.'));
  const otherConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-config-hard-stop-other.'));
  try {
    registerConfigProcessGroup(configDir, 'acp-runtime-host', {
      format: 'test-v1',
      pid: 41001,
      processGroupId: 41001,
      startedAt: 'Mon Aug 10 14:00:00 2026',
    });
    registerConfigProcessGroup(configDir, 'acp-provider', {
      format: 'test-v1',
      pid: 41002,
      processGroupId: 41002,
      startedAt: 'Mon Aug 10 14:00:01 2026',
    });
    registerConfigProcessGroup(otherConfigDir, 'native-pty-host', {
      format: 'test-v1',
      pid: 42001,
      processGroupId: 42001,
      startedAt: 'Mon Aug 10 14:00:02 2026',
    });

    const live = new Map([
      [41001, { pid: 41001, processGroupId: 41001, startedAt: 'Mon Aug 10 14:00:00 2026' }],
      [41002, { pid: 41002, processGroupId: 41002, startedAt: 'Mon Aug 10 14:00:01 2026' }],
      [42001, { pid: 42001, processGroupId: 42001, startedAt: 'Mon Aug 10 14:00:02 2026' }],
    ]);
    const signals = [];
    const result = await hardStopConfigProcesses(configDir, {
      readProcessIdentity(pid) {
        return live.get(pid) || null;
      },
      signalProcessGroup(processGroupId, signal) {
        signals.push({ processGroupId, signal });
        live.delete(processGroupId);
      },
      waitForProcessGroupExit: async () => true,
    });

    signals.sort((left, right) => left.processGroupId - right.processGroupId);
    assert.deepStrictEqual(signals, [
      { processGroupId: 41001, signal: 'SIGKILL' },
      { processGroupId: 41002, signal: 'SIGKILL' },
    ]);
    assert.strictEqual(result.stopped, 2);
    assert(live.has(42001), 'hard stop must not signal another Config process group');

    registerConfigProcessGroup(configDir, 'browser', {
      format: 'test-v1',
      pid: 43001,
      processGroupId: 43001,
      startedAt: 'persisted identity',
    });
    const mismatchedSignals = [];
    const mismatch = await hardStopConfigProcesses(configDir, {
      readProcessIdentity() {
        return { pid: 43001, processGroupId: 43001, startedAt: 'reused pid identity' };
      },
      signalProcessGroup(processGroupId, signal) {
        mismatchedSignals.push({ processGroupId, signal });
      },
      waitForProcessGroupExit: async () => true,
    });
    assert.deepStrictEqual(mismatchedSignals, []);
    assert.strictEqual(mismatch.refused, 1, 'PID reuse must fail closed without signaling');

    registerConfigProcessGroup(configDir, 'browser', {
      format: 'test-v1',
      pid: 44001,
      processGroupId: 44001,
      startedAt: 'exited identity',
    });
    const staleSignals = [];
    const stale = await hardStopConfigProcesses(configDir, {
      readProcessIdentity() {
        return null;
      },
      signalProcessGroup(processGroupId, signal) {
        staleSignals.push({ processGroupId, signal });
      },
      waitForProcessGroupExit: async () => true,
    });
    assert.deepStrictEqual(staleSignals, [], 'an exited persisted identity must not signal a reused process group');
    assert.strictEqual(stale.stopped, 0);

    registerConfigProcessGroup(configDir, 'acp-provider', {
      format: 'test-v1',
      pid: 43501,
      processGroupId: 43501,
      startedAt: 'exiting identity',
    });
    let exitingIdentityReads = 0;
    const exitingSignals = [];
    const exitedDuringReconciliation = await hardStopConfigProcesses(configDir, {
      readProcessIdentity(pid) {
        if (pid !== 43501) return null;
        exitingIdentityReads += 1;
        return exitingIdentityReads === 1
          ? { pid: 43501, processGroupId: 43501, startedAt: 'exiting identity changed during shutdown' }
          : null;
      },
      signalProcessGroup(processGroupId, signal) {
        exitingSignals.push({ processGroupId, signal });
      },
      waitForProcessGroupExit: async () => true,
    });
    assert.deepStrictEqual(exitingSignals, [], 'an identity that disappears during reconciliation must never be signalled');
    assert.deepStrictEqual(
      exitedDuringReconciliation,
      { stopped: 0, refused: 0 },
      'an identity that finishes exiting must be reconciled as stopped instead of blocking hard-stop',
    );
    const cleanedExitedIdentity = await hardStopConfigProcesses(configDir, {
      readProcessIdentity(pid) {
        return pid === 43501
          ? { pid: 43501, processGroupId: 43501, startedAt: 'later unrelated reuse' }
          : null;
      },
      waitForProcessGroupExit: async () => true,
    });
    assert.strictEqual(cleanedExitedIdentity.refused, 0, 'reconciled ownership must not poison a later hard-stop');

    registerConfigProcessGroup(configDir, 'acp-provider', {
      format: 'test-v1',
      pid: 45001,
      processGroupId: 45001,
      startedAt: 'zombie identity',
    });
    const zombieSignals = [];
    const zombie = await hardStopConfigProcesses(configDir, {
      readProcessIdentity() {
        return { pid: 45001, processGroupId: 45001, startedAt: 'zombie identity' };
      },
      isProcessZombie(pid) {
        return pid === 45001;
      },
      signalProcessGroup(processGroupId, signal) {
        zombieSignals.push({ processGroupId, signal });
      },
      waitForProcessGroupExit: async () => true,
    });
    assert.deepStrictEqual(zombieSignals, [], 'a zombie process group must not be signalled');
    assert.deepStrictEqual(zombie, { stopped: 0, refused: 0 }, 'a zombie is already stopped, not an ownership refusal');
    const cleanedZombie = await hardStopConfigProcesses(configDir, {
      readProcessIdentity() {
        return { pid: 45001, processGroupId: 45001, startedAt: 'reused after zombie' };
      },
      isProcessZombie() {
        return false;
      },
      waitForProcessGroupExit: async () => true,
    });
    assert.strictEqual(cleanedZombie.refused, 0, 'zombie ownership records must be removed after reconciliation');
  } finally {
    fs.rmSync(configDir, { recursive: true, force: true });
    fs.rmSync(otherConfigDir, { recursive: true, force: true });
  }

  if (process.platform !== 'win32') {
    const socketHostCases = [
      ['ACP', acpRuntimeHostSocketPath, true, true],
      ['native PTY', nativePtyHostSocketPath, false, true],
    ];
    if (process.platform === 'linux') {
      socketHostCases.push(['legacy native PTY', nativePtyHostSocketPath, false, false]);
    }
    for (const [role, socketPathForConfig, removeSocketDirectory, publishFingerprint] of socketHostCases) {
      const socketConfig = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-config-hard-stop-socket.'));
      const socketPath = socketPathForConfig(socketConfig);
      const child = spawn(
        process.execPath,
        ['-e', 'setInterval(() => {}, 1000)'],
        {
          detached: true,
          env: publishFingerprint ? process.env : { ...process.env, FARMING_CONFIG_DIR: socketConfig },
          stdio: 'ignore',
        },
      );
      const server = net.createServer(socket => {
        socket.on('data', data => {
          const request = JSON.parse(data.toString('utf8').trim());
          socket.end(`${JSON.stringify({
            id: request.id,
            result: {
              pid: child.pid,
              ...(publishFingerprint
                ? { configInstanceFingerprint: configInstanceFingerprint(socketConfig) }
                : {}),
            },
          })}\n`);
        });
      });
      try {
        await new Promise((resolve, reject) => {
          child.once('spawn', resolve);
          child.once('error', reject);
        });
        fs.mkdirSync(path.dirname(socketPath), { recursive: true });
        await new Promise((resolve, reject) => {
          server.once('error', reject);
          server.listen(socketPath, resolve);
        });
        assert.strictEqual(
          (await hardStopConfigProcesses(socketConfig)).stopped,
          1,
          `a ${role} Host with no ownership file must remain discoverable through its Config fingerprint`,
        );
      } finally {
        if (server.listening) await new Promise(resolve => server.close(resolve));
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          // The exact test process group may already have exited.
        }
        fs.rmSync(socketPath, { force: true });
        fs.rmSync(socketConfig, { recursive: true, force: true });
        if (removeSocketDirectory) {
          try {
            fs.rmdirSync(path.dirname(socketPath));
          } catch {
            // The exact socket directory may already be absent or contain another live fixture.
          }
        }
      }
    }
  }

  if (process.platform !== 'win32') {
    const firstConfig = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-config-hard-stop-live.'));
    const secondConfig = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-config-hard-stop-live-other.'));
    const children = [firstConfig, secondConfig].map(config => spawn(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      { detached: true, env: { ...process.env, FARMING_CONFIG_DIR: config }, stdio: 'ignore' },
    ));
    try {
      await Promise.all(children.map(child => new Promise((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
      })));
      const identities = children.map(child => require('../server-process-identity.cjs').readServerProcessIdentity(child.pid));
      registerConfigProcessGroup(firstConfig, 'acp-runtime-host', identities[0]);
      registerConfigProcessGroup(secondConfig, 'acp-runtime-host', identities[1]);
      const firstExit = new Promise(resolve => children[0].once('exit', resolve));
      assert.strictEqual((await hardStopConfigProcesses(firstConfig)).stopped, 1);
      await firstExit;
      assert.doesNotThrow(() => process.kill(children[1].pid, 0), 'another Config process must remain live');
    } finally {
      for (const child of children) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          // The exact test process group may already have exited.
        }
      }
      fs.rmSync(firstConfig, { recursive: true, force: true });
      fs.rmSync(secondConfig, { recursive: true, force: true });
    }
  }

  if (process.platform !== 'win32') {
    const sourceConfig = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-config-copy-source.'));
    const copiedConfig = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-config-copy-target.'));
    const child = spawn(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      { detached: true, env: { ...process.env, FARMING_CONFIG_DIR: sourceConfig }, stdio: 'ignore' },
    );
    try {
      await new Promise((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
      });
      const identity = require('../server-process-identity.cjs').readServerProcessIdentity(child.pid);
      assert(identity, 'copied Config fixture must expose a process identity');
      const resourcesDir = path.join(sourceConfig, 'browsers');
      fs.mkdirSync(resourcesDir, { recursive: true });
      fs.writeFileSync(path.join(resourcesDir, 'resources.json'), JSON.stringify({
        version: 6,
        resources: [{
          id: 'browser_copy_isolation',
          processIdentity: {
            ...identity,
            configInstanceFingerprint: configInstanceFingerprint(sourceConfig),
          },
        }],
      }));
      fs.cpSync(sourceConfig, copiedConfig, { recursive: true });

      assert.deepStrictEqual(
        await hardStopConfigProcesses(copiedConfig),
        { stopped: 0, refused: 0 },
        'a copied Config must not inherit authority over the source Browser process',
      );
      assert.doesNotThrow(() => process.kill(child.pid, 0), 'the source Browser process must remain live');
      assert.strictEqual(
        (await hardStopConfigProcesses(sourceConfig)).stopped,
        1,
        'the source Config must retain authority over its Browser process',
      );
    } finally {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // The exact test process group may already have exited.
      }
      fs.rmSync(sourceConfig, { recursive: true, force: true });
      fs.rmSync(copiedConfig, { recursive: true, force: true });
    }
  }
}

run().then(() => {
  console.log('config process hard-stop tests passed');
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
