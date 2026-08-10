const assert = require('assert');
const {
  AgentWorktreeRefreshQueue,
} = require('../agent-worktree-refresh-queue.cjs');
const { AgentManager } = require('../agent-manager.cjs');
const { createTestAgentManager } = require('./helpers/test-acp-runtime.ts');

interface TestAgentRecord {
  cwd: string;
  gitWorktree?: unknown;
  id: string;
  projectWorkspace: string;
  status: string;
}

async function run() {
  assert.throws(
    () => new AgentWorktreeRefreshQueue(0),
    /positive integer/,
  );

  const queue = new AgentWorktreeRefreshQueue(3);
  let active = 0;
  let maxActive = 0;
  const started: number[] = [];
  const results = await Promise.all(Array.from({ length: 12 }, (_, index) => (
    queue.enqueue(`agent-${index}`, async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      started.push(index);
      await new Promise(resolve => setImmediate(resolve));
      active -= 1;
      return true;
    })
  )));
  assert.strictEqual(maxActive, 3);
  assert.deepStrictEqual(started, Array.from({ length: 12 }, (_, index) => index));
  assert(results.every(Boolean));

  const scaleQueue = new AgentWorktreeRefreshQueue(4);
  let scaleActive = 0;
  let scaleMaxActive = 0;
  const scaleStartedAt = performance.now();
  await Promise.all(Array.from({ length: 10_000 }, (_, index) => (
    scaleQueue.enqueue(`scale-agent-${index}`, async () => {
      scaleActive += 1;
      scaleMaxActive = Math.max(scaleMaxActive, scaleActive);
      await Promise.resolve();
      scaleActive -= 1;
      return true;
    })
  )));
  const scaleElapsedMs = performance.now() - scaleStartedAt;
  assert.strictEqual(scaleMaxActive, 4);
  console.log(`Agent Worktree refresh queue scale ${JSON.stringify({
    agentCount: 10_000,
    elapsedMs: Number(scaleElapsedMs.toFixed(2)),
    maxActive: scaleMaxActive,
  })}`);

  const latestQueue = new AgentWorktreeRefreshQueue(1);
  let releaseBlocker: () => void = () => {};
  const blocker = latestQueue.enqueue('blocker', () => new Promise<boolean>(resolve => {
    releaseBlocker = () => resolve(false);
  }));
  await new Promise(resolve => setImmediate(resolve));
  let staleRuns = 0;
  let latestRuns = 0;
  const stale = latestQueue.enqueue('agent-a', async () => {
    staleRuns += 1;
    return false;
  });
  const latest = latestQueue.enqueue('agent-a', async () => {
    latestRuns += 1;
    return true;
  });
  releaseBlocker();
  assert.strictEqual(await blocker, false);
  assert.strictEqual(await stale, true);
  assert.strictEqual(await latest, true);
  assert.strictEqual(staleRuns, 0);
  assert.strictEqual(latestRuns, 1);

  let releaseCancelBlocker: () => void = () => {};
  const cancelQueue = new AgentWorktreeRefreshQueue(1);
  const cancelBlocker = cancelQueue.enqueue('blocker', () => new Promise<boolean>(resolve => {
    releaseCancelBlocker = () => resolve(true);
  }));
  await new Promise(resolve => setImmediate(resolve));
  let cancelledRan = false;
  const cancelled = cancelQueue.enqueue('cancelled', async () => {
    cancelledRan = true;
    return true;
  });
  assert.strictEqual(cancelQueue.cancelPending('cancelled'), true);
  assert.strictEqual(await cancelled, false);
  assert.strictEqual(cancelledRan, false);
  releaseCancelBlocker();
  assert.strictEqual(await cancelBlocker, true);

  const generationQueue = new AgentWorktreeRefreshQueue(1);
  let releaseGenerationTask: () => void = () => {};
  let generationTaskStarted: () => void = () => {};
  const generationStarted = new Promise<void>(resolve => { generationTaskStarted = resolve; });
  const invalidated = generationQueue.enqueue('reused-agent', async isCurrent => {
    generationTaskStarted();
    await new Promise<void>(resolve => { releaseGenerationTask = resolve; });
    return isCurrent();
  });
  await generationStarted;
  generationQueue.forget('reused-agent');
  releaseGenerationTask();
  assert.strictEqual(await invalidated, false, 'forget must invalidate an already active generation');

  const cancelAllQueue = new AgentWorktreeRefreshQueue(1);
  let releaseCancelAllBlocker: () => void = () => {};
  const cancelAllBlocker = cancelAllQueue.enqueue('blocker', () => new Promise<boolean>(resolve => {
    releaseCancelAllBlocker = () => resolve(true);
  }));
  await new Promise(resolve => setImmediate(resolve));
  const cancelledAll = [
    cancelAllQueue.enqueue('cancelled-a', async () => true),
    cancelAllQueue.enqueue('cancelled-b', async () => true),
  ];
  cancelAllQueue.cancelAllPending();
  assert.deepStrictEqual(await Promise.all(cancelledAll), [false, false]);
  releaseCancelAllBlocker();
  assert.strictEqual(await cancelAllBlocker, true);

  const recoveryQueue = new AgentWorktreeRefreshQueue(1);
  await assert.rejects(
    recoveryQueue.enqueue('bad', async () => {
      throw new Error('expected failure');
    }),
    /expected failure/,
  );
  assert.strictEqual(
    await recoveryQueue.enqueue('good', async () => true),
    true,
  );

  const manager = createTestAgentManager(AgentManager, {
    getHeartbeatInterval: () => 60_000,
    getWorkspace: () => process.cwd(),
  }, { skipExecutablePreflight: true });
  manager.heartbeatScheduler.stop();
  const initialAgent: TestAgentRecord = {
    id: 'agent-wiring',
    cwd: process.cwd(),
    projectWorkspace: process.cwd(),
    status: 'running',
  };
  manager.agents.set(initialAgent.id, initialAgent);
  const queuedTasks: Array<{
    agentId: string;
    resolve: (changed: boolean) => void;
    run: () => Promise<boolean>;
  }> = [];
  const queuedGenerations = new Map<string, number>();
  manager.agentWorktreeRefreshQueue = {
    enqueue(agentId: string, task: (isCurrent: () => boolean) => Promise<boolean>) {
      const generation = (queuedGenerations.get(agentId) || 0) + 1;
      queuedGenerations.set(agentId, generation);
      return new Promise<boolean>(resolve => {
        queuedTasks.push({
          agentId,
          resolve,
          run: () => task(() => queuedGenerations.get(agentId) === generation),
        });
      });
    },
    cancelPending: () => false,
    cancelAllPending: () => {},
    forget(agentId: string) {
      queuedGenerations.set(agentId, (queuedGenerations.get(agentId) || 0) + 1);
      return false;
    },
  };
  const initialRefresh = manager.refreshAgentWorktree(initialAgent.id);
  assert.deepStrictEqual(queuedTasks.map(task => task.agentId), [initialAgent.id]);
  const initialChanged = await queuedTasks[0].run();
  queuedTasks[0].resolve(initialChanged);
  assert.strictEqual(await initialRefresh, true);

  const oldAgent: TestAgentRecord = {
    id: 'agent-reused',
    cwd: process.cwd(),
    projectWorkspace: process.cwd(),
    status: 'running',
  };
  manager.agents.set(oldAgent.id, oldAgent);
  const oldRefresh = manager.refreshAgentWorktree(oldAgent.id);
  manager.deleteAgentRecord(oldAgent.id);
  const replacementAgent: TestAgentRecord = { ...oldAgent };
  manager.agents.set(replacementAgent.id, replacementAgent);
  const replacementRefresh = manager.refreshAgentWorktree(replacementAgent.id);
  const oldTask = queuedTasks[1];
  const oldChanged = await oldTask.run();
  oldTask.resolve(oldChanged);
  assert.strictEqual(await oldRefresh, false);
  assert.strictEqual(replacementAgent.gitWorktree, undefined);
  const replacementTask = queuedTasks[2];
  const replacementChanged = await replacementTask.run();
  replacementTask.resolve(replacementChanged);
  assert.strictEqual(await replacementRefresh, true);
  assert(replacementAgent.gitWorktree);
  await manager.dispose({ preserveTerminalHost: true });

  console.log('Agent Worktree refresh queue tests passed');
}

run().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
