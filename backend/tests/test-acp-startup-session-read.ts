const assert = require('node:assert/strict');
const { AgentManager } = require('../agent-manager.cjs');
const { createTestAgentManager } = require('./helpers/test-acp-runtime.ts');

async function run() {
  const sessions = new Map();
  let reads = 0;
  const manager = createTestAgentManager(AgentManager, {
    getHeartbeatInterval: () => 60_000,
    getTaskHistory: () => [],
  });
  manager.acpRuntime.hasBinding = id => sessions.has(id);
  manager.acpRuntime.getSessionForRead = async id => {
    reads++;
    return sessions.get(id);
  };
  try {
    for (const provider of ['codex', 'claude', 'opencode', 'pi', 'qoder', 'qwen']) {
      const id = `starting-${provider}`;
      const agent = manager.recoveredAgentRecord(id, 'native', {
        provider, agentRuntimeMode: 'acp', command: provider,
      }, { status: 'pending' });
      agent.runtimeBinding = { kind: 'acp', state: 'connecting', error: '' };
      manager.agents.set(id, agent);
      const finish = manager.lifecycleCoordinator.beginStart(id, false);
      try {
        const previousReads = reads;
        assert.equal(await manager.getAcpSessionForRead(id), null,
          'a published connecting Agent with an owned start is pending, not a read failure');
        assert.equal(reads, previousReads, 'do not ask the Host for an unregistered binding');
        assert.throws(() => manager.requireLiveAcpAgent(id), /still connecting/,
          'read-only pending must not grant mutation admission');

        agent.runtimeBinding.error = 'ACP initialization timed out';
        agent.runtimeBinding.state = 'error';
        await assert.rejects(manager.getAcpSessionForRead(id), /initialization timed out/);
        agent.runtimeBinding.state = 'connecting';
        await assert.rejects(manager.getAcpSessionForRead(id), /initialization timed out/);
        agent.runtimeBinding.error = '';

        const session = { agentId: id, state: 'connecting', sessionId: '', configOptions: [] };
        sessions.set(id, session);
        assert.equal(await manager.getAcpSessionForRead(id), session,
          'once bound, the Host snapshot owns connecting and ready state');
        finish();
        session.state = 'idle';
        assert.equal((await manager.getAcpSessionForRead(id)).state, 'idle');
        sessions.delete(id);
        await assert.rejects(manager.getAcpSessionForRead(id), /still connecting/,
          'a missing binding without an active start is not normal pending');
      } finally {
        finish();
        sessions.delete(id);
        manager.forgetStoppedAgentRecord(id);
      }
    }
    await assert.rejects(manager.getAcpSessionForRead('missing'), /Agent not found/);
  } finally {
    manager.heartbeatScheduler.stop();
    manager.engineBridge.dispose();
    await manager.acpRuntime.dispose();
  }
  console.log('ACP startup session reads distinguish pending, bound, failed, and unavailable across providers');
}

void run().catch(error => { console.error(error); process.exitCode = 1; });
