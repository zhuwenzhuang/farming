import assert from 'assert';
import { AgentLifecycleCoordinator } from '../agent-lifecycle-coordinator.cjs';

async function main() {
  let shuttingDown = false;
  const coordinator = new AgentLifecycleCoordinator({
    isShuttingDown: () => shuttingDown,
  });

  let releaseFirst!: () => void;
  const firstGate = new Promise<void>(resolve => {
    releaseFirst = resolve;
  });
  let firstToken: symbol | undefined;
  const first = coordinator.run('agent-a', 'restart', 'restart', 'restart', async token => {
    firstToken = token;
    await firstGate;
    return { restarted: true };
  });
  const duplicate = coordinator.run('agent-a', 'restart', 'restart', 'restart', () => ({
    restarted: false,
  }));
  assert.strictEqual(first, duplicate, 'same-key requests should share one lifecycle operation');
  await Promise.resolve();
  assert(firstToken, 'the admitted operation should receive its ownership token');
  assert.strictEqual(coordinator.adopt('agent-b', firstToken), true);
  assert.strictEqual(coordinator.get('agent-a'), coordinator.get('agent-b'));
  assert.strictEqual(coordinator.pendingOperations().length, 1);

  const conflicting = await coordinator.run(
    'agent-a',
    'restart:other',
    'restart',
    'restart',
    () => ({ restarted: false }),
    'restart conflict',
  );
  assert.deepStrictEqual(conflicting, { error: 'restart conflict' });

  let queuedRan = false;
  const queued = coordinator.run('agent-a', 'archive', 'archive', 'archive', () => {
    queuedRan = true;
    return { archived: true };
  });
  releaseFirst();
  assert.deepStrictEqual(await first, { restarted: true });
  assert.deepStrictEqual(await queued, { archived: true });
  assert.strictEqual(queuedRan, true);
  await coordinator.whenIdle('agent-a');
  assert.strictEqual(coordinator.get('agent-a'), undefined);
  assert.strictEqual(coordinator.get('agent-b'), undefined);

  shuttingDown = true;
  assert.deepStrictEqual(
    await coordinator.run('agent-c', 'kill', 'kill', 'kill', () => ({ killed: true })),
    { error: 'Farming is shutting down; Agent lifecycle changes are not accepted' },
  );
  assert.strictEqual(coordinator.beginStart('agent-c', false), null);
  const finishStart = coordinator.beginStart('agent-c', true);
  assert(finishStart);
  assert.strictEqual(coordinator.has('agent-c'), true);
  finishStart();
  await coordinator.whenIdle('agent-c');
  assert.strictEqual(coordinator.has('agent-c'), false);

  console.log('Agent lifecycle coordinator tests passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
