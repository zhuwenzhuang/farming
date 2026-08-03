const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const { AcpRuntimeHostProcess } = require('../acp-runtime-host-process.cts');
const { AcpRuntimeHostRuntime } = require('../acp-runtime-host-runtime.cts');

class FakeRuntime extends EventEmitter {
  constructor() {
    super();
    this.sessions = new Map();
    this.restartOptions = new Map();
    this.promptCalls = 0;
    this.promptCompletion = null;
  }

  bindingEpoch(agentId) {
    return this.sessions.get(agentId)?.bindingEpoch || '';
  }

  getSession(agentId) {
    const session = this.sessions.get(agentId);
    if (!session) throw new Error('missing session');
    return { ...session };
  }

  getSessionRequestOptions(agentId) {
    return this.restartOptions.has(agentId) ? {
      cwd: '/workspace',
      additionalDirectories: [],
      mcpServers: [],
    } : { cwd: '/workspace', additionalDirectories: [], mcpServers: [] };
  }

  getSessionForRead(agentId) {
    return {
      ...this.getSession(agentId),
      entries: [{ content: 'large transcript must not enter the facade mirror' }],
      transcriptTail: { entries: [] },
      updates: [{ large: true }],
    };
  }

  async prepareAgent(options) {
    this.restartOptions.set(options.agentId, {
      ...options,
      requestOptions: {
        cwd: options.cwd,
        additionalDirectories: options.additionalDirectories || [],
        configOverrides: options.configOverrides || [],
        mcpServers: options.mcpServers || [],
      },
    });
    const session = {
      agentId: options.agentId,
      bindingEpoch: options.capabilityRuntimeEpoch,
      provider: options.provider,
      sessionId: options.sessionId,
      cwd: options.cwd,
      state: 'idle',
      revision: 1,
      transcriptProjectionRevision: 1,
    };
    this.sessions.set(options.agentId, session);
    await options.onProcessStarted?.({ pid: 101, processGroupId: 101, startedAt: 'now' });
    this.emit('agent-runtime', session);
    this.emit('session', session);
    return {
      sessionId: options.sessionId,
      historyMode: 'load',
      configOverrides: options.configOverrides || [],
    };
  }

  submitMessage(_agentId, _prompt, options: { onSubmitted?: () => void } = {}) {
    this.promptCalls += 1;
    options.onSubmitted?.();
    return new Promise(resolve => {
      this.promptCompletion = resolve;
    });
  }

  async reconnectAgent(agentId, options: { onProcessStopped?: () => unknown } = {}) {
    const restart = this.restartOptions.get(agentId);
    const refreshed = await restart.refreshMcpServersForRuntime?.([{ id: 'browser' }]);
    if (refreshed?.capabilityRuntimeEpoch) {
      const session = this.sessions.get(agentId);
      session.bindingEpoch = refreshed.capabilityRuntimeEpoch;
      this.emit('agent-runtime', session);
    }
    await restart.onProcessStarted?.({ pid: 202, processGroupId: 202, startedAt: 'later' });
    await options.onProcessStopped?.();
    return { reconnected: true, refreshed };
  }

  async unregisterAgentAndWait(agentId) {
    this.restartOptions.delete(agentId);
    return this.sessions.delete(agentId);
  }

  setSessionMode() {
    return new Promise(() => {});
  }

  runWithForkReservation(agentId, _options, operation) {
    return operation({
      agentId,
      provider: 'codex',
      sessionId: this.sessions.get(agentId).sessionId,
      cwd: '/workspace',
    });
  }

  bindingCheckpoint() {
    return { exportCheckpoint: () => ({ version: 2, sessionState: { revision: 1 } }) };
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
  let lazySpawnCount = 0;
  const lazyFacade = new AcpRuntimeHostRuntime({
    configDir: os.tmpdir(),
    socketPath: '/unused-acp-runtime-host',
    spawnHost: () => { lazySpawnCount += 1; },
  });
  assert.strictEqual(lazySpawnCount, 0, 'constructing the default facade must not eagerly spawn a Host');
  lazyFacade.disconnect();

  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-acp-runtime-facade-'));
  const socketPath = path.join(configDir, 'host.sock');
  const runtime = new FakeRuntime();
  const host = new AcpRuntimeHostProcess({
    configDir,
    socketPath,
    runtime,
    exitOnShutdown: false,
  });
  const first = new AcpRuntimeHostRuntime({
    configDir,
    socketPath,
    connectRetries: 5,
  });
  let second;
  let third;
  try {
    await host.start();
    let initialProcessStarted = 0;
    await first.prepareAgent({
      agentId: 'agent-1',
      provider: 'codex',
      cwd: '/workspace',
      sessionId: 'session-1',
      capabilityRuntimeEpoch: 'binding-1',
      mcpServers: [],
      configOverrides: [{ configId: 'fast-mode', value: true }],
      onProcessStarted: () => {
        initialProcessStarted += 1;
      },
      refreshMcpServersForRuntime: mcpServers => ({
        capabilityRuntimeEpoch: 'binding-1',
        mcpServers,
      }),
    });
    assert.strictEqual(initialProcessStarted, 1);
    assert.deepStrictEqual(first.getSessionRequestOptions('agent-1').configOverrides, [
      { configId: 'fast-mode', value: true },
    ]);
    const mirroredSession = first.sessions.get('agent-1');
    first.sessions.delete('agent-1');
    assert.strictEqual(
      first.bindingEpoch('agent-1'),
      'binding-1',
      'mutation fencing must use the recovered Host-client binding even while the facade projection is catching up',
    );
    first.sessions.set('agent-1', mirroredSession);

    const initialHostEpoch = first.client.hostEpoch;
    const initialControllerGeneration = first.client.controllerGeneration;
    const recoveredRuntimeEvents = [];
    first.on('agent-runtime', event => recoveredRuntimeEvents.push(event));
    host.activeControllerClient.socket.destroy();
    await waitFor(
      () => first.client.controllerGeneration > initialControllerGeneration
        && Boolean(first.client.socket && !first.client.socket.destroyed),
      'facade did not reconnect to the surviving ACP runtime Host',
    );
    await waitFor(
      () => recoveredRuntimeEvents.some(event => event.agentId === 'agent-1'),
      'facade did not republish the recovered binding',
    );
    assert.strictEqual(first.client.hostEpoch, initialHostEpoch);
    assert.strictEqual(first.hasBinding('agent-1'), true);
    assert.strictEqual(
      recoveredRuntimeEvents.some(event => event.stopReason === 'interrupted'),
      false,
      'a transient Controller socket disconnect must not interrupt a Host-owned binding',
    );
    let submitted = false;
    const original = first.submitMessage(
      'agent-1',
      [{ type: 'text', text: 'continue across restart' }],
      { clientPromptId: 'request-1', onSubmitted: () => { submitted = true; } },
    );
    void original.catch(() => {});
    const submittedDeadline = Date.now() + 1000;
    while (!submitted && Date.now() < submittedDeadline) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.strictEqual(submitted, true, 'onSubmitted must not wait for a later session update');
    assert.strictEqual(runtime.promptCalls, 1);
    const originalRejected = assert.rejects(original, error => error?.uncertain === true);
    first.disconnect();
    await originalRejected;

    second = new AcpRuntimeHostRuntime({ configDir, socketPath, connectRetries: 5 });
    await second.initialize();
    assert.deepStrictEqual(second.getSessionRequestOptions('agent-1').configOverrides, [
      { configId: 'fast-mode', value: true },
    ], 'Server replacement must recover explicit overrides even when runtime request metadata omits them');
    assert.strictEqual(second.getSession('agent-1').state, 'working');
    let recoveredProcessStarted = 0;
    let recoveredProcessStopped = 0;
    let refreshCalls = 0;
    second.registerBindingCallbacks('agent-1', {
      onProcessStarted: () => { recoveredProcessStarted += 1; },
      onProcessStopped: () => { recoveredProcessStopped += 1; },
      refreshMcpServersForRuntime: mcpServers => {
        refreshCalls += 1;
        return { capabilityRuntimeEpoch: 'binding-2', mcpServers };
      },
    });
    const joined = second.submitMessage(
      'agent-1',
      [{ type: 'text', text: 'continue across restart' }],
      { clientPromptId: 'request-1' },
    );
    runtime.promptCompletion({ stopReason: 'end_turn' });
    assert.strictEqual((await joined).stopReason, 'end_turn');
    assert.strictEqual(runtime.promptCalls, 1);

    await second.reconnectAgent('agent-1', {
      onProcessStopped: () => { recoveredProcessStopped += 1; },
    });
    assert.strictEqual(refreshCalls, 1);
    assert.strictEqual(recoveredProcessStarted, 1);
    assert.strictEqual(recoveredProcessStopped, 1);
    assert.strictEqual(second.bindingEpoch('agent-1'), 'binding-2');

    second.disconnect();
    third = new AcpRuntimeHostRuntime({ configDir, socketPath, connectRetries: 5 });
    await third.initialize();
    let secondRestartRefresh = 0;
    third.registerBindingCallbacks('agent-1', {
      onProcessStarted: () => {},
      refreshMcpServersForRuntime: mcpServers => {
        secondRestartRefresh += 1;
        return { capabilityRuntimeEpoch: 'binding-3', mcpServers };
      },
    });
    await third.reconnectAgent('agent-1');
    assert.strictEqual(secondRestartRefresh, 1);
    assert.strictEqual(third.bindingEpoch('agent-1'), 'binding-3');
    const fullSession = await third.getSessionForRead('agent-1');
    assert.strictEqual(Array.isArray(fullSession.entries), true);
    assert.strictEqual(third.getSession('agent-1').entries.length, 0);
    assert.strictEqual(third.sessions.get('agent-1').transcriptTail, undefined);
    assert.strictEqual(third.sessions.get('agent-1').updates, undefined);
    const forkResult = await third.runWithForkReservation(
      'agent-1',
      { expectedRevision: 1, requireLoad: true },
      binding => ({
        sessionId: binding.sessionId,
        checkpoint: third.bindingCheckpoint(binding).exportCheckpoint(),
      }),
    );
    assert.strictEqual(forkResult.sessionId, 'session-1');
    assert.strictEqual(forkResult.checkpoint.sessionState.revision, 1);

    const previousHostEpoch = third.client.hostEpoch;
    await assert.rejects(
      third.client.request('setSessionMode', {
        agentId: 'agent-1',
        modeId: 'slow',
      }, { timeoutMs: 20 }),
      error => error?.uncertain === true,
    );
    await third.initialize();
    assert.strictEqual(third.client.hostEpoch, previousHostEpoch);
    assert.strictEqual(third.hasBinding('agent-1'), true, 'a poisoned mutation channel must recover via a new generation');

    const interruptedEvents = [];
    third.on('agent-runtime', event => interruptedEvents.push(event));
    const missingBindingHostEpoch = third.client.hostEpoch;
    const missingBindingGeneration = third.client.controllerGeneration;
    host.activeControllerClient.socket.destroy();
    host.service.state.bindings.delete('agent-1');
    await waitFor(
      () => third.client.controllerGeneration > missingBindingGeneration
        && Boolean(third.client.socket && !third.client.socket.destroyed),
      'facade did not reconnect after the binding disappeared',
    );
    await waitFor(
      () => interruptedEvents.some(event => event.agentId === 'agent-1' && event.stopReason === 'interrupted'),
      'missing authoritative Host binding was not marked interrupted',
    );
    assert.strictEqual(third.client.hostEpoch, missingBindingHostEpoch);
    assert.strictEqual(third.hasBinding('agent-1'), false);
  } finally {
    first.disconnect();
    second?.disconnect();
    third?.disconnect();
    await host.dispose();
    fs.rmSync(configDir, { recursive: true, force: true });
  }

  const replacedHostFacade = new AcpRuntimeHostRuntime({
    configDir: os.tmpdir(),
    socketPath: '/unused-acp-runtime-host-replaced',
    spawnHost: () => {},
  });
  try {
    replacedHostFacade.client.hostEpoch = 'host-new';
    replacedHostFacade.sessions.set('agent-replaced', {
      agentId: 'agent-replaced',
      bindingEpoch: 'binding-new',
      state: 'idle',
      revision: 2,
    });
    replacedHostFacade.bindings.set('agent-replaced', {
      agentId: 'agent-replaced',
      provider: 'codex',
      sessionId: 'session-new',
      cwd: '/workspace',
    });
    const replacementEvents = [];
    replacedHostFacade.on('agent-runtime', event => replacementEvents.push(event));
    replacedHostFacade.reconcileRecoveredBindings(new Map([
      ['agent-replaced', {
        agentId: 'agent-replaced',
        bindingEpoch: 'binding-old',
        state: 'working',
        revision: 1,
      }],
    ]), 'host-old');
    assert.strictEqual(
      replacementEvents.some(event => event.stopReason === 'interrupted'),
      true,
      'a new Host epoch must interrupt the previous Host-owned binding before publishing recovered state',
    );
  } finally {
    replacedHostFacade.disconnect();
  }

  console.log('ACP runtime Host facade tests passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
