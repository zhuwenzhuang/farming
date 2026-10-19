import assert from 'node:assert/strict';
const { AgentManager } = require('../agent-manager.cjs');

async function run() {
  for (const provider of ['codex', 'claude', 'agy']) {
    const manager = Object.create(AgentManager.prototype);
    const agent = { id: 'agent', providerSessionProvider: provider, runtimeBinding: { kind: 'acp', state: 'error', error: '' } };
    manager.agents = new Map([['agent', agent]]);
    manager.assertAgentOperationAdmission = () => {};
    manager.assertSubagentParentAvailable = () => {};
    manager.sessionPersistence = {
      persist: () => { throw new Error('reconnect must not synchronously persist runtime state'); },
      scheduleState: () => {},
    };
    let bound = false;
    let recoveries = 0;
    manager.acpRuntime = {
      initialize: async () => {},
      hasBinding: () => bound,
      reconnectAgent: async () => { assert(bound); return { reconnected: true }; },
      setSessionMode: async () => ({ mode: 'code' }),
    };
    manager.recoverAcpSessions = async () => { recoveries++; bound = true; };
    assert.deepEqual(await manager.setAcpSessionMode('agent', 'code'), { mode: 'code' });
    assert.equal(recoveries, 1, 'configuration mutations must reach missing-binding recovery');
    await manager.reconnectAcpAgent('agent');
    assert.equal(recoveries, 1, 'a healthy binding must not trigger recovery');
    bound = false;
    manager.recoverAcpSessions = async () => { agent.runtimeBinding.error = 'Process exit cannot be proven'; };
    await assert.rejects(manager.reconnectAcpAgent('agent'), { code: 'ACP_RUNTIME_UNAVAILABLE', message: 'Process exit cannot be proven' });
    assert.throws(() => manager.getAcpSession('agent'), { code: 'ACP_RUNTIME_UNAVAILABLE' }, 'ordinary reads remain read-only');
  }
  console.log('ACP reconnect recovery passed');
}

void run().catch(error => { console.error(error); process.exitCode = 1; });
