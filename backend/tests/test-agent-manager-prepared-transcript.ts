const assert = require('assert');
const path = require('path');
const AgentManager = require('../agent-manager.cjs');
const { AcpRuntime } = require('../acp-runtime.cjs');

const PROCESS_IDENTITY = {
  describeAcpProcessGroup: async (pid: number) => ({
    pid,
    processGroupId: pid,
    startedAt: `prepared-transcript-${pid}`,
  }),
};

function config() {
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
    getAgentHome: () => ({ id: 'default', path: path.join(process.env.HOME, '.codex') }),
  };
}

async function waitFor(predicate: () => boolean, message: string) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise<void>(resolve => setTimeout(resolve, 10));
  }
  throw new Error(message);
}

async function run() {
  const fixture = path.join(__dirname, 'fixtures', 'fake-acp-agent.mts');
  const runtime = new AcpRuntime({
    ...PROCESS_IDENTITY,
    resolveLaunch: () => ({
      command: process.execPath,
      args: ['--import', require.resolve('tsx'), fixture],
      version: 'test',
    }),
  });
  const manager = new AgentManager(config(), {
    acpRuntime: runtime,
    skipExecutablePreflight: true,
    transcriptMediaPathPrefix: (agentId: string) => `/farming/api/agents/${agentId}/acp-media`,
  });
  try {
    const agentId = await new Promise<string>((resolve, reject) => {
      manager.startAgent('claude', process.cwd(), (id: string | null, error: string) => {
        if (error || !id) reject(new Error(error || 'Agent did not start'));
        else resolve(id);
      }, { agentRuntimeMode: 'chat', wantsMain: false });
    });
    const binding = runtime.bindings.get(agentId);
    assert(binding, 'ACP binding should exist');
    binding.sessionState.apply({
      sessionId: binding.sessionId,
      update: {
        sessionUpdate: 'user_message_chunk',
        messageId: 'prepared-user',
        content: { type: 'text', text: 'Prepared transcript request' },
      },
    });
    binding.sessionState.apply({
      sessionId: binding.sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'prepared-answer',
        content: { type: 'text', text: 'Prepared transcript answer' },
      },
    });
    binding.state = 'idle';
    runtime.emitSession(binding);
    await waitFor(
      () => manager.acpPreparedTranscriptCache.stats().entries === 1,
      'idle transcript did not reach the prepared cache',
    );

    let onDemandBuilds = 0;
    const originalBuild = manager.buildAcpTranscript.bind(manager);
    manager.buildAcpTranscript = (...args: unknown[]) => {
      onDemandBuilds += 1;
      return originalBuild(...args);
    };
    const transcript = manager.getAcpTranscript(agentId, {
      maxTurns: 20,
      mediaPathPrefix: `/farming/api/agents/${agentId}/acp-media`,
    });
    assert.strictEqual(onDemandBuilds, 0, 'prepared GET should not repeat transcript projection');
    assert(transcript.transcript.entries.some((entry: { id?: string }) => entry.id === 'prepared-answer'));
    assert.strictEqual(transcript.runtimeEpoch, binding.capabilityRuntimeEpoch);
    assert.strictEqual(transcript.replace, true);
    assert.strictEqual(transcript.settled, true);

    manager.forgetStoppedAgentRecord(agentId, { emitUpdate: false });
    assert.strictEqual(manager.acpPreparedTranscriptCache.stats().entries, 0);
    console.log('test-agent-manager-prepared-transcript passed');
  } finally {
    await manager.dispose();
  }
}

run().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
