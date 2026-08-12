const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const { AcpRuntimeHostClient, acpRuntimeHostSpawnCommand } = require('../acp-runtime-host-client.cts');
const { acpRuntimeHostIdentity } = require('../acp-runtime-host-identity.cts');
const { AcpRuntimeHostProcess } = require('../acp-runtime-host-process.cts');
const { acpRuntimeHostSocketPath } = require('../acp-runtime-host-path.cts');
const { promptContentHash } = require('../acp-runtime-host-service.cts');
const { configInstanceFingerprint } = require('../config-instance.cts');

class FakeRuntime extends EventEmitter {
  constructor() {
    super();
    this.sessions = new Map();
    this.promptCalls = 0;
    this.promptCompletion = null;
  }

  bindingEpoch(agentId) {
    return this.sessions.get(agentId)?.bindingEpoch || '';
  }

  getSession(agentId) {
    return { ...this.sessions.get(agentId) };
  }

  async prepareAgent(options) {
    const session = {
      agentId: options.agentId,
      bindingEpoch: options.capabilityRuntimeEpoch,
      sessionId: options.sessionId,
      state: 'idle',
      revision: 1,
    };
    this.sessions.set(options.agentId, session);
    this.emit('agent-runtime', session);
    return { sessionId: options.sessionId, historyMode: 'load' };
  }

  submitMessage(agentId, _prompt, options: { onSubmitted?: () => void } = {}) {
    this.promptCalls += 1;
    options.onSubmitted?.();
    const session = this.sessions.get(agentId);
    session.state = 'working';
    session.revision += 1;
    this.emit('agent-runtime', session);
    return new Promise(resolve => {
      this.promptCompletion = result => {
        session.state = 'idle';
        session.revision += 1;
        this.emit('agent-runtime', session);
        resolve(result);
      };
    });
  }

  async dispose() {}
}

async function waitFor(predicate, message) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(message);
}

async function main() {
  assert.deepStrictEqual(
    acpRuntimeHostSpawnCommand('/opt/farming/backend/acp-runtime-host.cjs', {
      FARMING_NODE_BIN: '/opt/farming/node',
      FARMING_NODE_LD: '/opt/glibc/lib/ld-linux-x86-64.so.2',
      FARMING_NODE_LIBRARY_PATH: '/opt/glibc/lib',
    }, false, 'linux'),
    {
      command: '/opt/glibc/lib/ld-linux-x86-64.so.2',
      args: [
        '--library-path',
        '/opt/glibc/lib',
        '/opt/farming/node',
        '/opt/farming/backend/acp-runtime-host.cjs',
      ],
    },
    'ACP Host must inherit the same loader-aware Node invocation as the Server and PTY Host',
  );
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-acp-runtime-host-client-'));
  const socketPath = path.join(configDir, 'host.sock');
  const runtime = new FakeRuntime();
  const host = new AcpRuntimeHostProcess({ configDir, socketPath, runtime, exitOnShutdown: false });
  let first;
  let second;
  try {
    await host.start();
    first = new AcpRuntimeHostClient({ configDir, socketPath, connectRetries: 5 });
    await first.ensureConnected();
    const wrongConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-acp-runtime-host-wrong-config-'));
    try {
      const wrongClient = new AcpRuntimeHostClient({
        configDir: wrongConfigDir,
        socketPath,
        connectRetries: 1,
        spawnHost: () => {},
      });
      await assert.rejects(
        wrongClient.ensureConnected(),
        /another config instance/,
      );
      wrongClient.disconnect();
    } finally {
      fs.rmSync(wrongConfigDir, { recursive: true, force: true });
    }
    await first.request('prepareAgent', {
      options: {
        agentId: 'agent-1',
        capabilityRuntimeEpoch: 'binding-1',
        sessionId: 'session-1',
      },
    });
    const mismatchedClient = new AcpRuntimeHostClient({
      configDir,
      socketPath,
      connectRetries: 1,
      expectedBuildId: '0'.repeat(64),
      spawnHost: () => {},
    });
    await assert.rejects(mismatchedClient.ensureConnected(), error => {
      assert.match(error.message, /older ACP runtime Host/);
      assert.match(error.message, new RegExp(`PID ${process.pid}`));
      assert.match(error.message, /owns 1 active Chat session/);
      const expectedStopCommand = process.platform === 'win32'
        ? `taskkill /PID ${process.pid} /T`
        : `kill -TERM ${process.pid}`;
      assert.match(error.message, new RegExp(expectedStopCommand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.match(error.message, /did not stop it automatically/);
      assert.match(error.message, /Stopping it will terminate all 1 session/);
      assert.match(error.message, new RegExp(JSON.stringify(configDir).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      return true;
    }, 'an incompatible Host with live bindings must be preserved with an actionable stop command');
    mismatchedClient.disconnect();
    assert.strictEqual(host.disposed, false);
    const forcedConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-acp-force-rotation-'));
    const forcedRotation = new AcpRuntimeHostClient({
      configDir: forcedConfigDir,
      socketPath,
      connectRetries: 1,
      expectedBuildId: acpRuntimeHostIdentity().buildId,
      forceReplaceActiveHost: true,
      spawnHost: () => {},
    });
    const forcedMethods: string[] = [];
    forcedRotation.connectOnce = async () => {};
    forcedRotation.request = async (method: string) => {
      forcedMethods.push(method);
      if (method === 'ping') {
        return {
          runtimeIdentity: { protocolVersion: 1, buildId: acpRuntimeHostIdentity().buildId },
          configInstanceFingerprint: configInstanceFingerprint(forcedConfigDir),
          bindingCount: 1,
          pid: process.pid,
        };
      }
      return {};
    };
    await assert.rejects(
      forcedRotation.ensureConnected(),
      /Replaced an existing ACP runtime Host for a full restart/,
    );
    assert.deepStrictEqual(
      forcedMethods,
      ['ping', 'registerController', 'shutdownHost'],
      'a full restart must replace even a compatible Host with active Chats',
    );
    forcedRotation.disconnect();
    fs.rmSync(forcedConfigDir, { recursive: true, force: true });
    const absentConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-acp-force-absent-'));
    const absentSocketPath = path.join(absentConfigDir, 'host.sock');
    const absentMethods: string[] = [];
    let absentSpawnCalls = 0;
    const absentRotation = new AcpRuntimeHostClient({
      configDir: absentConfigDir,
      socketPath: absentSocketPath,
      connectRetries: 3,
      connectRetryMs: 1,
      forceReplaceActiveHost: true,
      spawnHost: () => { absentSpawnCalls += 1; return 4242; },
    });
    let absentConnectCalls = 0;
    absentRotation.connectOnce = async () => {
      absentConnectCalls += 1;
      if (absentConnectCalls === 1) {
        const error = new Error('Host absent') as Error & { code?: string };
        error.code = 'ENOENT';
        throw error;
      }
    };
    absentRotation.request = async (method: string) => {
      absentMethods.push(method);
      if (method === 'ping') {
        return {
          runtimeIdentity: acpRuntimeHostIdentity(),
          configInstanceFingerprint: configInstanceFingerprint(absentConfigDir),
          bindingCount: 0,
          pid: 4242,
        };
      }
      return method === 'recover'
        ? { replace: true, eventSeq: 0, bindings: [], promptOperations: [], cancelOperations: [] }
        : {};
    };
    await absentRotation.ensureConnected();
    assert.strictEqual(absentSpawnCalls, 1, 'a missing Host must spawn exactly one fresh generation');
    assert.deepStrictEqual(
      absentMethods,
      ['ping', 'registerController', 'recover'],
      'a Host spawned by this full restart must not be rotated again',
    );
    absentRotation.disconnect();
    fs.rmSync(absentConfigDir, { recursive: true, force: true });
    const original = first.request('submitPrompt', {
      agentId: 'agent-1',
      bindingEpoch: 'binding-1',
      clientPromptId: 'prompt-1',
      contentHash: promptContentHash([{ type: 'text', text: 'work' }]),
      prompt: [{ type: 'text', text: 'work' }],
    }, { timeoutMs: 0 });
    await waitFor(() => runtime.promptCalls === 1, 'prompt was not admitted');
    first.disconnect();
    await assert.rejects(original, /disconnected|closed/);

    second = new AcpRuntimeHostClient({ configDir, socketPath, connectRetries: 5 });
    await second.ensureConnected();
    assert.strictEqual(second.controllerGeneration, 3);
    assert.strictEqual(second.bindings.get('agent-1').state, 'working');
    assert.strictEqual(second.promptOperations.get('agent-1\0prompt-1').status, 'provider-owned');
    const joined = second.request('submitPrompt', {
      agentId: 'agent-1',
      bindingEpoch: 'binding-1',
      clientPromptId: 'prompt-1',
      contentHash: promptContentHash([{ type: 'text', text: 'work' }]),
      prompt: [{ type: 'text', text: 'work' }],
    }, { timeoutMs: 0 });
    runtime.promptCompletion({ stopReason: 'end_turn' });
    assert.strictEqual((await joined).stopReason, 'end_turn');
    assert.strictEqual(runtime.promptCalls, 1);
  } finally {
    first?.disconnect();
    second?.disconnect();
    await host.dispose();
    fs.rmSync(configDir, { recursive: true, force: true });
  }

  const fullRestartConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-acp-full-restart-'));
  const fullRestartSocketPath = acpRuntimeHostSocketPath(fullRestartConfigDir);
  const oldRuntime = new FakeRuntime();
  const oldHost = new AcpRuntimeHostProcess({
    configDir: fullRestartConfigDir,
    socketPath: fullRestartSocketPath,
    runtime: oldRuntime,
    exitOnShutdown: false,
  });
  let oldController;
  let fullRestartController;
  try {
    await oldHost.start();
    oldController = new AcpRuntimeHostClient({
      configDir: fullRestartConfigDir,
      socketPath: fullRestartSocketPath,
      connectRetries: 10,
      connectRetryMs: 10,
    });
    await oldController.ensureConnected();
    await oldController.request('prepareAgent', {
      options: {
        agentId: 'agent-full-restart',
        capabilityRuntimeEpoch: 'binding-full-restart',
        sessionId: 'session-full-restart',
      },
    });
    const oldHostEpoch = oldController.hostEpoch;
    oldController.disconnect();
    oldController = null;

    fullRestartController = new AcpRuntimeHostClient({
      configDir: fullRestartConfigDir,
      socketPath: fullRestartSocketPath,
      connectRetries: 100,
      connectRetryMs: 20,
      forceReplaceActiveHost: true,
    });
    await fullRestartController.ensureConnected();
    assert.strictEqual(oldHost.disposed, true, 'full restart must dispose a compatible old Host');
    assert.notStrictEqual(
      fullRestartController.hostEpoch,
      oldHostEpoch,
      'full restart must attach a new Host generation',
    );
    assert.strictEqual(
      fullRestartController.bindings.has('agent-full-restart'),
      false,
      'a fresh Host must not expose the old generation binding',
    );
    await fullRestartController.request('shutdownHost', {}, { timeoutMs: 5_000 });
  } finally {
    oldController?.disconnect();
    fullRestartController?.disconnect();
    await oldHost.dispose();
    fs.rmSync(fullRestartConfigDir, { recursive: true, force: true });
  }

  const raceClient = new AcpRuntimeHostClient({ configDir: os.tmpdir(), socketPath: '/unused' });
  raceClient.hostEpoch = 'host-race';
  let releaseRecovery;
  raceClient.request = () => new Promise(resolve => {
    releaseRecovery = resolve;
  });
  const racingRecovery = raceClient.recover(true);
  raceClient.applyEvent('runtime-event', {
    seq: 2,
    type: 'binding',
    payload: { agentId: 'agent-race', bindingEpoch: 'binding-race', state: 'working', revision: 2 },
  });
  releaseRecovery({
    hostEpoch: 'host-race',
    eventSeq: 1,
    replace: true,
    bindings: [{ agentId: 'agent-race', bindingEpoch: 'binding-race', state: 'idle', revision: 1 }],
    promptOperations: [],
  });
  await racingRecovery;
  assert.strictEqual(raceClient.eventSeq, 2);
  assert.strictEqual(raceClient.bindings.get('agent-race').revision, 2);

  const gapClient = new AcpRuntimeHostClient({ configDir: os.tmpdir(), socketPath: '/unused' });
  gapClient.hostEpoch = 'host-gap';
  gapClient.eventSeq = 1;
  let recoveryCalls = 0;
  gapClient.request = async (_method, params) => {
    recoveryCalls += 1;
    if (recoveryCalls === 1) {
      assert.strictEqual(params.afterEventSeq, 1);
      return {
        hostEpoch: 'host-gap',
        eventSeq: 3,
        replace: false,
        events: [{ seq: 3, type: 'binding', payload: { agentId: 'agent-gap', revision: 3 } }],
      };
    }
    assert.strictEqual(params.afterEventSeq, undefined);
    return {
      hostEpoch: 'host-gap',
      eventSeq: 3,
      replace: true,
      bindings: [{ agentId: 'agent-gap', bindingEpoch: 'binding-gap', state: 'working', revision: 3 }],
      promptOperations: [],
    };
  };
  await gapClient.recover();
  assert.strictEqual(recoveryCalls, 2, 'an event gap must force full recovery');
  assert.strictEqual(gapClient.bindings.get('agent-gap').revision, 3);

  console.log('ACP runtime host client tests passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
