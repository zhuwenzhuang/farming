const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const {
  AcpRuntime,
  describeAcpProcessGroup,
  stopPersistedAcpProcessGroup,
} = require('../acp-runtime.cjs');
const { configInstanceFingerprint } = require('../config-instance.cjs');
const { readServerProcessIdentity } = require('../server-process-identity.cjs');

async function waitForProcessIdentity(pid) {
  const deadline = Date.now() + 5_000;
  while (Date.now() <= deadline) {
    const identity = await describeAcpProcessGroup(pid);
    if (identity) return identity;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`process ${pid} did not expose an ACP process-group identity`);
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

async function killOwnedProcess(child) {
  if (!child?.pid || !processIsAlive(child.pid)) return;
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
  await new Promise(resolve => child.once('close', resolve));
}

async function run() {
  if (process.platform === 'win32') {
    console.log('ACP Config process-scope tests skipped on Windows');
    return;
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-acp-config-scope-'));
  const configA = path.join(tempRoot, 'config-a');
  const configB = path.join(tempRoot, 'config-b');
  fs.mkdirSync(configA);
  fs.mkdirSync(configB);
  const fingerprintA = configInstanceFingerprint(configA);
  const fingerprintB = configInstanceFingerprint(configB);
  const children = [];
  let runtime = null;

  try {
    assert.deepStrictEqual(
      await stopPersistedAcpProcessGroup({
        pid: 99_999_991,
        processGroupId: 99_999_991,
        startedAt: 'missing',
        configInstanceFingerprint: fingerprintA,
      }),
      { stopped: false, missingConfigScope: true },
      'cleanup without the current Config scope must fail before inspecting or signalling a process',
    );
    assert.deepStrictEqual(
      await stopPersistedAcpProcessGroup({
        pid: 99_999_992,
        processGroupId: 99_999_992,
        startedAt: 'already-exited',
        configInstanceFingerprint: fingerprintA,
      }, fingerprintB),
      { stopped: false, configScopeMismatch: true },
      'a copied scoped record must not bypass its Config fence merely because the old process exited',
    );

    const legacyChild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true,
      env: { ...process.env, FARMING_CONFIG_DIR: configA },
      stdio: 'ignore',
    });
    children.push(legacyChild);
    const legacyIdentity = await waitForProcessIdentity(legacyChild.pid);
    const previousTimeZone = process.env.TZ;
    try {
      process.env.TZ = 'Asia/Shanghai';
      assert.deepStrictEqual(
        await describeAcpProcessGroup(legacyChild.pid),
        readServerProcessIdentity(legacyChild.pid),
        'ACP ownership identity must use the same time-zone-independent format as hard-stop reconciliation',
      );
    } finally {
      if (previousTimeZone === undefined) delete process.env.TZ;
      else process.env.TZ = previousTimeZone;
    }
    const legacyCleanup = await stopPersistedAcpProcessGroup(legacyIdentity, fingerprintA);
    assert.strictEqual(legacyCleanup.stopped, true);
    assert.strictEqual(
      processIsAlive(legacyChild.pid),
      false,
      'a legacy identity may be stopped only after its live FARMING_CONFIG_DIR proves ownership',
    );

    const copiedLegacyChild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true,
      env: { ...process.env, FARMING_CONFIG_DIR: configA },
      stdio: 'ignore',
    });
    children.push(copiedLegacyChild);
    const copiedLegacyIdentity = await waitForProcessIdentity(copiedLegacyChild.pid);
    assert.deepStrictEqual(
      await stopPersistedAcpProcessGroup(copiedLegacyIdentity, fingerprintB),
      { stopped: false, configScopeMismatch: true },
      'a legacy identity copied to another Config must use the live process environment as its scope fence',
    );
    assert.strictEqual(processIsAlive(copiedLegacyChild.pid), true);
    assert.strictEqual(
      (await stopPersistedAcpProcessGroup(copiedLegacyIdentity, fingerprintA)).stopped,
      true,
    );

    if (process.platform === 'darwin') {
      const spacedConfig = path.join(tempRoot, 'config with spaces');
      fs.mkdirSync(spacedConfig);
      const spacedLegacyChild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        detached: true,
        env: { ...process.env, FARMING_CONFIG_DIR: spacedConfig },
        stdio: 'ignore',
      });
      children.push(spacedLegacyChild);
      const spacedLegacyIdentity = await waitForProcessIdentity(spacedLegacyChild.pid);
      const spacedCleanup = await stopPersistedAcpProcessGroup(
        spacedLegacyIdentity,
        configInstanceFingerprint(spacedConfig),
      );
      assert.strictEqual(spacedCleanup.stopped, false);
      assert.strictEqual(
        processIsAlive(spacedLegacyChild.pid),
        true,
        'ambiguous macOS ps environment output must fail closed for legacy Config paths containing spaces',
      );
    }

    const copiedChild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true,
      env: { ...process.env, FARMING_CONFIG_DIR: configA },
      stdio: 'ignore',
    });
    children.push(copiedChild);
    const copiedIdentity = {
      ...await waitForProcessIdentity(copiedChild.pid),
      configInstanceFingerprint: fingerprintA,
    };
    const copiedCleanup = await stopPersistedAcpProcessGroup(copiedIdentity, fingerprintB);
    assert.deepStrictEqual(copiedCleanup, { stopped: false, configScopeMismatch: true });
    assert.strictEqual(
      processIsAlive(copiedChild.pid),
      true,
      'copying a persisted identity into another Config must never signal the original ACP process',
    );
    assert.strictEqual(
      (await stopPersistedAcpProcessGroup(copiedIdentity, fingerprintA)).stopped,
      true,
      'the owning Config must still be able to clean up its exact process identity',
    );

    let startedIdentity = null;
    const fixture = path.join(__dirname, 'fixtures', 'fake-acp-agent.mts');
    runtime = new AcpRuntime({
      configDir: configA,
      resolveLaunch: () => ({
        command: process.execPath,
        args: ['--import', require.resolve('tsx'), fixture],
        version: 'test',
      }),
    });
    await runtime.prepareAgent({
      agentId: 'agent-config-scoped-process',
      provider: 'codex',
      cwd: process.cwd(),
      env: { ...process.env, FARMING_CONFIG_DIR: configA },
      approvalMode: 'full',
      onProcessStarted: identity => {
        startedIdentity = identity;
      },
    });
    assert(startedIdentity, 'ACP startup must persist its process identity before opening the start gate');
    assert.strictEqual(startedIdentity.configInstanceFingerprint, fingerprintA);
  } finally {
    if (runtime) await runtime.dispose();
    for (const child of children) await killOwnedProcess(child);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

run().then(() => {
  console.log('ACP Config process scope tests passed');
}).catch(error => {
  console.error(error);
  process.exit(1);
});
