const assert = require('assert');
const path = require('path');
const AgentManager = require('../agent-manager');
const { AcpRuntime } = require('../acp-runtime');

function config() {
  return {
    getWorkspace: () => process.cwd(),
    getHeartbeatInterval: () => 60_000,
    getTaskHistory: () => [],
    getDangerouslySkipAgentPermissionsByDefault: () => false,
    getAgentLaunchProfiles: () => ({}),
    getCodexApprovalMode: () => 'full',
    getCodexRuntimeMode: () => 'cli',
    getAgentHome: () => ({ id: 'default', path: path.join(process.env.HOME, '.codex') }),
  };
}

async function run() {
  const fixture = path.join(__dirname, 'fixtures', 'fake-acp-agent.mjs');
  const runtime = new AcpRuntime({
    resolveLaunch: () => ({ command: process.execPath, args: [fixture], version: 'test' }),
  });
  const manager = new AgentManager(config(), { acpRuntime: runtime });
  try {
    const agentId = await new Promise(resolve => {
      manager.startAgent('codex', process.cwd(), (id, error) => {
        assert.ifError(error);
        resolve(id);
      }, {
        agentRuntimeMode: 'acp',
        codexRuntimeMode: 'cli',
        codexApprovalMode: 'full',
      });
    });
    assert(agentId);
    const live = manager.agents.get(agentId);
    assert.strictEqual(live.agentRuntimeMode, 'acp');
    assert.strictEqual(live.engineStarted, false);
    assert.strictEqual(live.providerSessionId, 'acp-new-session');
    assert.strictEqual(live.providerSessionSource, 'acp-new');

    const result = await manager.sendComposerMessage(agentId, 'manager prompt');
    assert.strictEqual(result.kind, 'acp');
    assert.strictEqual(result.stopReason, 'end_turn');
    const session = manager.getAcpSession(agentId);
    assert.strictEqual(session.entries.find(item => item.role === 'assistant').content[0].text, 'ACP reply');
    const listed = await manager.listAcpSessions(agentId);
    assert.strictEqual(listed.sessions.length, 1);
    assert.strictEqual(manager.getAcpTranscript(agentId).turns[0].finalMessage, 'ACP reply');
    assert.strictEqual((await manager.forkAcpSession(agentId)).sessionId, 'acp-fork-session');
    assert.strictEqual((await manager.setAcpSessionMode(agentId, 'plan')).modeId, 'plan');
  } finally {
    await manager.dispose();
  }
  console.log('agent manager ACP tests passed');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
