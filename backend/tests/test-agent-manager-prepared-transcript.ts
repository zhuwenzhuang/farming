const assert = require('assert');
const path = require('path');
const { AgentManager } = require('../agent-manager.cjs');
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
    assert.strictEqual(
      manager.acpPreparedTranscriptCache.stats().records,
      0,
      'idle inventory updates must not make every Chat a prepared-cache candidate',
    );
    manager.prioritizeAcpPreparedTranscript(agentId);
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
    const transcript = await manager.getAcpTranscript(agentId, {
      maxTurns: 5,
      mediaPathPrefix: `/farming/api/agents/${agentId}/acp-media`,
    });
    assert.strictEqual(onDemandBuilds, 0, 'prepared GET should not repeat transcript projection');
    assert(transcript.transcript.entries.some((entry: { id?: string }) => entry.id === 'prepared-answer'));
    assert.strictEqual(transcript.runtimeEpoch, binding.capabilityRuntimeEpoch);
    assert.strictEqual(transcript.replace, true);
    assert.strictEqual(transcript.settled, true);
    const serialized = await manager.getAcpTranscriptSerialized(agentId, {
      maxTurns: 5,
      mediaPathPrefix: `/farming/api/agents/${agentId}/acp-media`,
    });
    assert.strictEqual(JSON.parse(serialized).toRevision, transcript.toRevision);

    binding.state = 'error';
    binding.stopReason = 'error';
    binding.error = 'runtime-only failure';
    binding.updatedAt = new Date(Date.now() + 1_000).toISOString();
    runtime.emitRuntime(binding);
    const runtimeChanged = await manager.getAcpTranscript(agentId, {
      maxTurns: 5,
      mediaPathPrefix: `/farming/api/agents/${agentId}/acp-media`,
    });
    assert.strictEqual(onDemandBuilds, 1, 'runtime-only changes must invalidate the serialized envelope');
    assert.strictEqual(runtimeChanged.transcript.state, 'error');
    assert.strictEqual(runtimeChanged.transcript.stopReason, 'error');

    binding.state = 'working';
    runtime.emitRuntime(binding);
    manager.buildAcpTranscript = originalBuild;
    let concurrentBuilds = 0;
    let releaseBuild: () => void = () => {};
    const buildGate = new Promise<void>(resolve => { releaseBuild = resolve; });
    manager.buildAcpTranscript = async (...args: unknown[]) => {
      concurrentBuilds += 1;
      await buildGate;
      return originalBuild(...args);
    };
    const concurrentOptions = {
      maxTurns: 5,
      mediaPathPrefix: `/farming/api/agents/${agentId}/acp-media`,
    };
    const firstRead = manager.getAcpTranscript(agentId, concurrentOptions);
    await waitFor(() => concurrentBuilds === 1, 'concurrent transcript read did not start');
    binding.sessionState.apply({
      sessionId: binding.sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'coalesced-live-update',
        content: { type: 'text', text: 'Live update while the shared read is in flight' },
      },
    });
    runtime.emitSession(binding);
    const secondRead = manager.getAcpTranscript(agentId, concurrentOptions);
    releaseBuild();
    const [firstConcurrent, secondConcurrent] = await Promise.all([firstRead, secondRead]);
    assert.strictEqual(concurrentBuilds, 1, 'identical transcript reads must share one in-flight build');
    assert.deepStrictEqual(secondConcurrent, firstConcurrent);

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
