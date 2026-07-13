const assert = require('assert');
const path = require('path');
const AgentManager = require('../agent-manager');
const { AcpRuntime } = require('../acp-runtime');

function config(overrides = {}) {
  return {
    getWorkspace: () => process.cwd(),
    getHeartbeatInterval: () => 60_000,
    getTaskHistory: () => [],
    getDangerouslySkipAgentPermissionsByDefault: () => false,
    getAgentLaunchProfiles: () => ({}),
    getCodexApprovalMode: () => 'full',
    getCodexModel: () => 'gpt-5.5',
    getCodexReasoningEffort: () => 'xhigh',
    getCodexServiceTier: () => 'priority',
    getCodexRuntimeMode: () => 'cli',
    getAgentHome: () => ({ id: 'default', path: path.join(process.env.HOME, '.codex') }),
    ...overrides,
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
    const binding = runtime.bindings.get(agentId);
    assert.strictEqual(binding.env.INITIAL_AGENT_MODE, 'agent-full-access');
    assert.deepStrictEqual(JSON.parse(binding.env.CODEX_CONFIG), {
      model: 'gpt-5.5',
      model_reasoning_effort: 'xhigh',
      service_tier: 'priority',
    });

    const result = await manager.sendComposerMessage(agentId, 'manager prompt');
    assert.strictEqual(result.kind, 'acp');
    assert.strictEqual(result.stopReason, 'end_turn');
    const session = manager.getAcpSession(agentId);
    assert.strictEqual(session.entries.find(item => item.role === 'assistant').content[0].text, 'ACP reply');
    await manager.sendComposerMessage(agentId, [
      { type: 'text', text: 'inspect image' },
      { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' },
    ]);
    const imagePrompt = manager.getAcpSession(agentId).entries
      .filter(item => item.role === 'user')
      .at(-1);
    assert.strictEqual(imagePrompt.content[0].text, 'inspect image');
    assert.strictEqual(imagePrompt.content[1].type, 'image');
    const listed = await manager.listAcpSessions(agentId);
    assert.strictEqual(listed.sessions.length, 1);
    assert.strictEqual(manager.getAcpTranscript(agentId).turns[0].finalMessage, 'ACP reply');
    assert.strictEqual((await manager.forkAcpSession(agentId)).sessionId, 'acp-fork-session');
    assert.strictEqual((await manager.setAcpSessionMode(agentId, 'plan')).modeId, 'plan');
  } finally {
    await manager.dispose();
  }

  const recoveryRuntime = new AcpRuntime({
    resolveLaunch: () => ({ command: process.execPath, args: [fixture], version: 'test' }),
  });
  const recoveryManager = new AgentManager(config({
    listAgentSessionRecords: () => [{
      id: 'fsess-recovered',
      runtimeAgentId: 'agent-acp-recovered',
      agentRuntimeMode: 'acp',
      providerSessionProvider: 'codex',
      providerSessionId: 'existing-session',
      cwd: process.cwd(),
      status: 'running',
    }],
  }), { acpRuntime: recoveryRuntime });
  try {
    await recoveryManager.recoverAcpSessions();
    const recoveredBinding = recoveryRuntime.bindings.get('agent-acp-recovered');
    assert(recoveredBinding);
    assert.strictEqual(recoveredBinding.env.INITIAL_AGENT_MODE, 'agent-full-access');
    assert.deepStrictEqual(JSON.parse(recoveredBinding.env.CODEX_CONFIG), {
      model: 'gpt-5.5',
      model_reasoning_effort: 'xhigh',
      service_tier: 'priority',
    });
  } finally {
    await recoveryManager.dispose();
  }
  console.log('agent manager ACP tests passed');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
