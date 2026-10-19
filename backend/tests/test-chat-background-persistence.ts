import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentComposerAdmissionCoordinator } from '../agent-composer-admission.cts';
import { AgentSessionPersistenceService } from '../agent-session-persistence-service.cts';
import { AcpSessionOptionsStore } from '../acp-session-options-store.cjs';
import { AcpSessionState } from '../acp-session-state.cjs';
import type { AgentRecord } from '../agent-manager-record-types.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(settle => { resolve = settle; });
  return { resolve, promise };
}

for (const kind of ['acp', 'terminal'] as const) {
  test(`${kind}: stalled persistence cannot delay admission, acknowledgement or deduplication`, async () => {
    const disk = deferred<void>();
    const submitted = deferred<void>();
    const agent: AgentRecord = { id: 'background-agent', composerCommands: [] };
    let current = agent;
    let writes = 0;
    let deliveries = 0;
    const published: unknown[] = [];
    const service = new AgentSessionPersistenceService({
      config: {
        persistAgentStatePatch: async (_agent, patch, options) => {
          const snapshot = structuredClone(patch);
          writes += 1;
          await disk.promise;
          if (!options.beforeCommit()) return { status: 'fenced' };
          published.push(snapshot);
          return { status: 'committed' };
        },
      },
      getAgent: () => current,
      isRecoveryComplete: () => true,
      isVerifiedStopped: () => false,
      observeOrder: () => {},
      sessionOptions: new AcpSessionOptionsStore(),
    });
    const coordinator = new AgentComposerAdmissionCoordinator({
      captureDeliveryOwner: () => ({ assertCurrent: () => assert.equal(current, agent) }),
      runtimeKind: () => kind,
      schedulePersistence: record => service.scheduleState(record),
      deliver: async request => {
        deliveries += 1;
        await submitted.promise;
        request.onSubmitted({ kind });
        return { kind };
      },
    });
    const request = { agent, requestId: 'held-disk', message: 'send while disk is blocked' };
    const admission = coordinator.request(request);
    await Promise.resolve();
    assert.equal(deliveries, 1, 'provider dispatch must precede disk IO');
    assert.equal(writes, 0, 'intent must not start a write on the send stack');
    const flush = service.flushState();
    assert.equal(writes, 1);
    try {
      submitted.resolve();
      assert.deepEqual(await admission, { kind, accepted: true });
      assert.equal((await coordinator.request(request) as { deduplicated: boolean }).deduplicated, true);
      assert.equal(deliveries, 1);
      for (let index = 0; index < 100; index += 1) service.scheduleState(agent);
      assert.equal(writes, 1, 'new snapshots must coalesce while a write is blocked');
    } finally {
      disk.resolve();
      await flush;
      await service.flushState();
      await coordinator.whenIdle(agent.id);
    }
    assert.equal(writes, 2);
    assert.deepEqual(published, [{ composerCommands: agent.composerCommands,
      agentRuntimeMode: 'terminal', chatTurn: undefined,
      attentionSeq: undefined,
      readAttentionSeq: undefined,
      attentionUpdatedAt: undefined,
      readAttentionAt: undefined,
      attentionReason: undefined,
      attentionOutputEpoch: undefined,
      attentionOutputSeq: undefined,
      readOutputEpoch: undefined,
      readOutputSeq: undefined,
      unread: false,
      providerSessionMaterialized: undefined, lastActivityAt: undefined, terminalInputReceived: undefined,
      structuredRuntimeProcess: undefined, subagentRetained: undefined, subagentSupervisionExpiresAt: undefined }]);
    service.scheduleState(agent);
    current = { id: agent.id };
    await service.flushState();
    assert.equal(writes, 2, 'replaced owners cannot persist stale snapshots');
  });
}

test('routine checkpoints exclude production-sized native conversation content', () => {
  for (const provider of ['codex', 'claude', 'pi', 'opencode', 'qoder', 'qwen', 'agy']) {
    const state = new AcpSessionState({ provider, sessionId: 'native-history', cwd: '/workspace' });
    for (let index = 0; index < 200; index += 1) {
      state.beginPrompt([{ type: 'text', text: `question ${index}` }]);
      state.apply({ sessionId: 'native-history', update: {
        sessionUpdate: 'agent_message_chunk', messageId: `answer-${index}`,
        content: { type: 'text', text: 'native-output-'.repeat(1000) },
      } });
      state.completePrompt('end_turn');
    }
    const metadata = state.exportRecoveryCheckpoint(true);
    assert.deepEqual(metadata.entries, []);
    assert.ok(JSON.stringify(metadata).length < 1024, provider);
    assert.ok(JSON.stringify(state.exportCheckpoint()).length > 2_000_000, provider);
  }
});

test('all ACP providers submit and reconnect while checkpoint IO is blocked', async () => {
  const { AcpRuntime } = await import('../acp-runtime.cjs');
  const path = await import('node:path');
  const fixture = path.join(__dirname, 'fixtures', 'fake-acp-agent.mts');
  for (const provider of ['codex', 'claude', 'pi', 'opencode', 'qoder', 'qwen', 'agy']) {
    const disk = deferred<void>();
    const turn = deferred<{ stopReason: string }>();
    const submitted = deferred<void>();
    let diskCalls = 0;
    const runtime = new AcpRuntime({
      checkpointStore: {
        load: async () => { diskCalls += 1; await disk.promise; return null; },
        schedule: () => {},
        markDirty: async () => { diskCalls += 1; await disk.promise; },
        write: async () => { diskCalls += 1; await disk.promise; },
        flush: async () => {},
        dispose: async () => {},
      },
      resolveLaunch: () => ({ command: process.execPath, args: ['--import', require.resolve('tsx'), fixture], version: 'test' }),
    });
    let execution: Promise<unknown> | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await runtime.prepareAgent({ agentId: 'disk-test', provider, cwd: process.cwd(), env: process.env, approvalMode: 'full' });
      const binding = runtime.requireBinding('disk-test');
      binding.connection.prompt = () => turn.promise;
      binding.connection.request = async () => ({ turnId: 'steered' });
      execution = runtime.prompt('disk-test', [{ type: 'text', text: 'send without saving history' }], { onSubmitted: () => submitted.resolve() });
      await Promise.race([submitted.promise, new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`${provider} waited for checkpoint IO`)), 1000);
      })]);
      clearTimeout(timeout);
      await runtime.steer('disk-test', [{ type: 'text', text: 'steer without saving history' }]);
      assert.equal(diskCalls, 0, provider);
      turn.resolve({ stopReason: 'end_turn' });
      await execution;
      binding.state = 'error';
      binding.stopReason = 'error';
      binding.retryableReconnect = true;
      await Promise.race([runtime.reconnectAgent('disk-test'), new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`${provider} reconnect waited for checkpoint IO`)), 5000);
      })]);
      assert.equal(diskCalls, 0, `${provider} reconnect must transfer recovery metadata in memory`);
    } finally {
      clearTimeout(timeout);
      disk.resolve();
      turn.resolve({ stopReason: 'end_turn' });
      await execution?.catch(() => {});
      await runtime.dispose();
    }
  }
});
