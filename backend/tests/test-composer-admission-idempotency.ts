const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { AcpRuntime } = require('../acp-runtime.cjs');
const AgentManager = require('../agent-manager.cjs');
const { ConfigManager } = require('../config-manager.cjs');

interface ComposerTestAgent {
  id: string;
  command: string;
  forkCommand: string;
  cwd: string;
  projectWorkspace: string;
  status: string;
  engineName: string;
  category: string;
  source: string;
  providerSessionProvider: string;
  providerHomeId: string;
  providerSessionId: string;
  providerSessionKey: string;
  providerSessionTemporary: boolean;
  runtimeBinding: { kind: string; state: string };
  persistentSessionId?: string;
  agentRecordId?: string;
}

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-composer-admission-'));
  const configManager = new ConfigManager({ configDir: root });
  configManager.init();
  const runtime = new AcpRuntime();
  runtime.hasBinding = () => true;
  let submitCount = 0;
  let releaseTurn = () => {};
  let releaseSubmission = () => {};
  let holdSubmission = false;
  let rejectBeforeSubmission = false;
  let reconnectRequired = false;
  let reconnectCount = 0;
  runtime.reconnectAgent = async () => {
    if (!reconnectRequired) return { reconnected: false };
    reconnectRequired = false;
    reconnectCount += 1;
    return { reconnected: true };
  };
  runtime.submitMessage = async (
    _agentId,
    _prompt,
    options: { onSubmitted?: () => void } = {},
  ) => {
    submitCount += 1;
    if (rejectBeforeSubmission) {
      reconnectRequired = true;
      throw new Error('simulated ACP connection closed before admission');
    }
    if (holdSubmission) {
      await new Promise<void>(resolve => {
        releaseSubmission = resolve;
      });
    }
    options.onSubmitted?.();
    await new Promise<void>(resolve => {
      releaseTurn = resolve;
    });
    return { stopReason: 'end_turn' };
  };
  const manager = new AgentManager(configManager, {
    acpRuntime: runtime,
    skipExecutablePreflight: true,
  });
  try {
    await manager.whenRecovered();
    const agent: ComposerTestAgent = {
      id: 'agent-composer-admission',
      command: 'claude',
      forkCommand: 'claude',
      cwd: root,
      projectWorkspace: root,
      status: 'running',
      engineName: 'native',
      category: 'coding',
      source: 'ui',
      providerSessionProvider: 'claude',
      providerHomeId: 'default',
      providerSessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      providerSessionKey: 'agent-session:claude:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      providerSessionTemporary: false,
      runtimeBinding: { kind: 'acp', state: 'idle' },
    };
    agent.persistentSessionId = configManager.ensureAgentSessionRecord(agent, { archived: false });
    agent.agentRecordId = agent.persistentSessionId;
    manager.agents.set(agent.id, agent);

    const accepted = await manager.sendComposerMessage(agent.id, 'persist this once', {
      requestId: 'composer-request-1',
    });
    assert.strictEqual(accepted.accepted, true);
    assert.strictEqual(submitCount, 1);
    const persistedAccepted = configManager.sessionStore.readRecord(agent.persistentSessionId)
      .composerCommands.find(command => command.requestId === 'composer-request-1');
    assert.strictEqual(persistedAccepted.state, 'accepted');
    const replayed = await manager.sendComposerMessage(agent.id, 'persist this once', {
      requestId: 'composer-request-1',
    });
    assert.strictEqual(replayed.deduplicated, true);
    assert.strictEqual(submitCount, 1, 'a lost response retry must not submit a second ACP prompt');
    await assert.rejects(
      () => manager.sendComposerMessage(agent.id, 'different content', { requestId: 'composer-request-1' }),
      /different content/,
    );
    releaseTurn();

    holdSubmission = true;
    const concurrentOne = manager.sendComposerMessage(agent.id, 'join concurrent delivery', {
      requestId: 'composer-request-concurrent',
    });
    await new Promise(resolve => setImmediate(resolve));
    const concurrentTwo = manager.sendComposerMessage(agent.id, 'join concurrent delivery', {
      requestId: 'composer-request-concurrent',
    });
    releaseSubmission();
    const [concurrentAcceptedOne, concurrentAcceptedTwo] = await Promise.all([concurrentOne, concurrentTwo]);
    assert.strictEqual(concurrentAcceptedOne.accepted, true);
    assert.strictEqual(concurrentAcceptedTwo.accepted, true);
    assert.strictEqual(submitCount, 2, 'concurrent delivery of one Composer request must join one provider submission');
    holdSubmission = false;
    releaseTurn();

    const ensureAgentSessionRecord = configManager.ensureAgentSessionRecord.bind(configManager);
    configManager.ensureAgentSessionRecord = (candidate, patch) => {
      const command = candidate.composerCommands?.find(item => item.requestId === 'composer-request-2');
      if (command?.state === 'accepted') {
        throw new Error('simulated accepted admission write failure');
      }
      return ensureAgentSessionRecord(candidate, patch);
    };
    await assert.rejects(
      () => manager.sendComposerMessage(agent.id, 'uncertain admission', { requestId: 'composer-request-2' }),
      error => error?.uncertain === true && /accepted admission write failure/.test(error.message),
    );
    assert.strictEqual(submitCount, 3);
    configManager.ensureAgentSessionRecord = ensureAgentSessionRecord;
    await assert.rejects(
      () => manager.sendComposerMessage(agent.id, 'uncertain admission', { requestId: 'composer-request-2' }),
      error => error?.uncertain === true && /admission could not be saved/.test(error.message),
    );
    assert.strictEqual(submitCount, 3, 'UNKNOWN admission must never replay automatically');
    const persistedIntent = configManager.sessionStore.readRecord(agent.persistentSessionId)
      .composerCommands.find(command => command.requestId === 'composer-request-2');
    assert.strictEqual(persistedIntent.state, 'intent', 'the crash-safe disk state remains conservative when accepted persistence fails');
    releaseTurn();

    rejectBeforeSubmission = true;
    await assert.rejects(
      () => manager.sendComposerMessage(agent.id, 'retry after reconnect', {
        requestId: 'composer-request-reconnect',
      }),
      /connection closed before admission/,
    );
    const persistedFailure = configManager.sessionStore.readRecord(agent.persistentSessionId)
      .composerCommands.find(command => command.requestId === 'composer-request-reconnect');
    assert.strictEqual(persistedFailure.state, 'failed');
    rejectBeforeSubmission = false;
    const retriedAfterReconnect = await manager.sendComposerMessage(agent.id, 'retry after reconnect', {
      requestId: 'composer-request-reconnect',
    });
    assert.strictEqual(retriedAfterReconnect.accepted, true);
    assert.strictEqual(reconnectCount, 1, 'a definitive failed retry must reconnect before provider admission');
    assert.strictEqual(submitCount, 5, 'the failed attempt and explicit retry should each submit at most once');
    releaseTurn();

    console.log('test-composer-admission-idempotency passed');
  } finally {
    releaseTurn();
    releaseSubmission();
    await manager.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
