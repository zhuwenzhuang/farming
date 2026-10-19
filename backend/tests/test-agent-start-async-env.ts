import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConfigManager } from '../config-manager.cjs';
import { AgentManager } from '../agent-manager.cjs';
import { AgentShellEnvResolver, resolveUserShellEnv } from '../agent-env.cjs';
import { createTestAgentManager } from './helpers/test-acp-runtime.ts';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(settle => { resolve = settle; });
  return { resolve, promise };
}

test('startup shares asynchronous shell probes without losing create admission or Main identity', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-async-start-'));
  const gate = deferred();
  const entered = deferred();
  const config = new ConfigManager({ configDir: root });
  config.init();
  config.getWorkspace = () => root;
  const manager = createTestAgentManager(AgentManager, config, { skipExecutablePreflight: true });
  let probes = 0;
  manager.agentShellEnvResolver.dispose();
  manager.agentShellEnvResolver = new AgentShellEnvResolver({
    provider: () => { throw new Error('startup must not call the synchronous resolver'); },
    asyncProvider: async () => {
      probes += 1;
      entered.resolve();
      await gate.promise;
      return { PATH: process.env.PATH, FARMING_ENV_TEST: 'resolved' };
    },
  });
  let creates = 0;
  const engine = manager.engineBridge.getEngine('local');
  engine.createSession = async options => {
    creates += 1;
    assert.equal(options.env.FARMING_ENV_TEST, 'resolved');
    return { sessionId: options.agentId, status: 'running' };
  };
  manager.engineBridge.resolve = () => ({ engineName: 'local', spec: { category: 'other' }, engine });
  const first = manager.startAgent('bash', root, null, { wantsMain: true, createRequestId: 'same-start' });
  const duplicate = manager.startAgent('bash', root, null, { wantsMain: true, createRequestId: 'same-start' });
  const otherMain = manager.startAgent('bash', root, null, { wantsMain: true, createRequestId: 'other-main' });
  try {
    await entered.promise;
    const concurrentEnv = manager.buildAgentEnv('env-only', { id: 'env-only', category: 'coding', command: 'codex' });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(creates, 0);
    assert.equal(probes, 1, 'startup discovery and launch environment share the pending default-shell probe');
    assert.equal(manager.startAdmissionCoordinator.pendingOperations().length, 2, 'duplicate request retains one admission');
    gate.resolve();
    await concurrentEnv;
    const ids = await Promise.all([first, duplicate, otherMain]);
    assert.ok(ids[0]);
    assert.deepEqual(ids, [ids[0], ids[0], ids[0]]);
    assert.equal(creates, 1, 'parallel shell wait must not admit duplicate Main runtimes');
    assert.equal(manager.startAdmissionCoordinator.pendingOperations().length, 0);
  } finally {
    gate.resolve();
    await Promise.allSettled([first, duplicate, otherMain]);
    manager.agentShellEnvResolver.dispose();
    manager.heartbeatScheduler.stop();
    await manager.engineBridge.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('asynchronous shell probe times out without blocking the event loop and preserves failure semantics', async () => {
  let ticks = 0;
  const timer = setInterval(() => { ticks += 1; }, 10);
  try {
    const result = await resolveUserShellEnv({ shell: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'], timeoutMs: 250,
      processEnv: { ...process.env, FARMING_AGENT_SHELL_ENV: '1' } });
    assert.equal(result, null);
    assert.ok(ticks >= 2, 'server callbacks remain runnable while shell discovery is stalled');
  } finally {
    clearInterval(timer);
  }
});
