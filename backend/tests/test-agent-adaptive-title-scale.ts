const assert = require('assert');
const { AgentManager } = require('../agent-manager.cjs');

async function run() {
  const persisted = [];
  let failTitleAgentId = '';
  let holdTitleAgentId = '';
  let releaseHeldWrite: () => void = () => {};
  const heldWriteGate = new Promise<void>(resolve => {
    releaseHeldWrite = resolve;
  });
  let observeHeldWrite: () => void = () => {};
  const heldWriteStarted = new Promise<void>(resolve => {
    observeHeldWrite = resolve;
  });
  const manager = new AgentManager({
    getWorkspace: () => process.cwd(),
    getHeartbeatInterval: () => 60_000,
    getCodingAgentEngine: () => 'local',
    getVtBaseUrl: () => 'http://localhost:4020',
    getDangerouslySkipAgentPermissionsByDefault: () => false,
    ensureAgentSessionRecord(agent, patch = {}) {
      throw new Error(`unexpected synchronous title persistence for ${agent.id}: ${JSON.stringify(patch)}`);
    },
    async persistAgentAdaptiveTitle(agent, adaptiveTitle) {
      await new Promise(resolve => setImmediate(resolve));
      if (agent.id === holdTitleAgentId) {
        observeHeldWrite();
        await heldWriteGate;
      }
      if (agent.id === failTitleAgentId) throw new Error('simulated asynchronous title failure');
      persisted.push({ ...agent, adaptiveTitle });
      return agent.agentRecordId || `agent_record_${agent.id}`;
    },
  }, { skipExecutablePreflight: true });

  const scopedUpdates = [];
  let fullUpdates = 0;
  manager.on('agent-update', update => scopedUpdates.push(update));
  manager.on('update', () => { fullUpdates += 1; });

  try {
    const count = 128;
    const acknowledgements = [];
    for (let index = 0; index < count; index += 1) {
      const id = `agent-title-scale-${index}`;
      manager.agents.set(id, {
        id,
        command: 'codex',
        forkCommand: 'codex',
        cwd: process.cwd(),
        projectWorkspace: process.cwd(),
        output: '',
        previewText: '',
        previewCols: 80,
        previewRows: 24,
        sessionTitle: '',
        adaptiveTitle: '',
        customTitle: '',
        status: 'running',
        engineName: 'local',
        engineStarted: false,
        wantsMain: false,
        category: 'coding',
        task: `Scale task ${index}`,
        source: 'ui',
        providerSessionProvider: 'codex',
        providerSessionId: `codex-scale-session-${index}`,
        providerSessionKey: `agent-session:codex:codex-scale-session-${index}`,
        providerSessionTemporary: false,
        agentRecordId: `agent_record_${id}`,
        persistentSessionId: `agent_record_${id}`,
        runtimeBinding: { kind: 'terminal' },
        runtimeEpoch: `runtime-${index}`,
        validated: true,
        startedAt: Date.now(),
      });
      manager.activityTracker.record(id);

      const first = manager.setAgentAdaptiveTitle(id, `Draft scale title ${index}`);
      const latest = manager.setAgentAdaptiveTitle(id, `Final scale title ${index}`);
      assert.strictEqual(first, latest, 'one Agent should expose one joined durability result');
      acknowledgements.push(latest);
    }

    assert.strictEqual(persisted.length, 0, 'the startup fan-out must not persist on the request stack');
    assert.strictEqual(fullUpdates, 0, 'title fan-out must not broadcast the full Agent inventory');
    assert.strictEqual(scopedUpdates.length, count * 2);

    const results = await Promise.all(acknowledgements);
    assert(results.every(result => !result.error));
    assert.strictEqual(persisted.length, count, 'each Agent should persist only its latest queued title');
    assert.strictEqual(
      new Set(persisted.map(record => record.id)).size,
      count,
      'persistence must remain exactly isolated by Agent record',
    );
    for (let index = 0; index < count; index += 1) {
      const id = `agent-title-scale-${index}`;
      assert.strictEqual(manager.agents.get(id).adaptiveTitle, `Final scale title ${index}`);
      assert.strictEqual(
        persisted.find(record => record.id === id).adaptiveTitle,
        `Final scale title ${index}`,
      );
    }

    const shutdownTitle = manager.setAgentAdaptiveTitle(
      'agent-title-scale-0',
      'Durable before shutdown',
    );
    await manager.drainAcceptedAgentOperations();
    assert.strictEqual((await shutdownTitle).adaptiveTitle, 'Durable before shutdown');
    assert.strictEqual(persisted.at(-1).adaptiveTitle, 'Durable before shutdown');

    holdTitleAgentId = 'agent-title-scale-1';
    let staleRuntimeMetadataUpdates = 0;
    manager.updateEngineProviderSessionMetadata = () => {
      staleRuntimeMetadataUpdates += 1;
    };
    const acceptedBeforeRuntimeRotation = manager.setAgentAdaptiveTitle(
      holdTitleAgentId,
      'Accepted before runtime rotation',
    );
    await heldWriteStarted;
    manager.agents.get(holdTitleAgentId).runtimeEpoch = 'replacement-runtime';
    releaseHeldWrite();
    assert.strictEqual(
      (await acceptedBeforeRuntimeRotation).adaptiveTitle,
      'Accepted before runtime rotation',
    );
    assert.strictEqual(staleRuntimeMetadataUpdates, 0);
    assert.strictEqual(persisted.at(-1).adaptiveTitle, 'Accepted before runtime rotation');

    failTitleAgentId = 'agent-title-scale-0';
    const failedTitle = await manager.setAgentAdaptiveTitle(
      failTitleAgentId,
      'Must roll back after failure',
    );
    assert.match(failedTitle.error, /simulated asynchronous title failure/);
    assert.strictEqual(manager.agents.get(failTitleAgentId).adaptiveTitle, 'Durable before shutdown');
    assert.strictEqual(
      persisted.filter(record => record.id === failTitleAgentId).at(-1).adaptiveTitle,
      'Durable before shutdown',
    );

    console.log('✓ adaptive titles coalesce and stay Agent-scoped during 128-Agent startup fan-out');
  } finally {
    clearInterval(manager.heartbeatInterval);
    await manager.drainAcceptedAgentOperations();
    await manager.engineBridge.dispose();
  }
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
