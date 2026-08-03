const assert = require('assert');
const { AgentManager } = require('../agent-manager.cjs');

async function run() {
  const persisted = [];
  const manager = new AgentManager({
    getWorkspace: () => process.cwd(),
    getHeartbeatInterval: () => 60_000,
    getCodingAgentEngine: () => 'local',
    getVtBaseUrl: () => 'http://localhost:4020',
    getDangerouslySkipAgentPermissionsByDefault: () => false,
    ensureAgentSessionRecord(agent, patch = {}) {
      persisted.push({ ...agent, ...patch });
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
      const token = `title-token-${index}`;
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
        runtimeBinding: { kind: 'terminal' },
        titleUpdateToken: token,
        validated: true,
        startedAt: Date.now(),
      });
      manager.lastActivity.set(id, Date.now());

      const first = manager.setAgentAdaptiveTitle(id, `Draft scale title ${index}`, token);
      const latest = manager.setAgentAdaptiveTitle(id, `Final scale title ${index}`, token);
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
      'title-token-0',
    );
    await manager.drainAcceptedAgentOperations();
    assert.strictEqual((await shutdownTitle).adaptiveTitle, 'Durable before shutdown');
    assert.strictEqual(persisted.at(-1).adaptiveTitle, 'Durable before shutdown');

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
