const assert = require('assert');

const { AgentInputCoordinator } = require('../agent-input-coordinator.cjs');

async function waitFor(predicate: () => boolean, message: string) {
  const deadline = Date.now() + 500;
  while (Date.now() <= deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  throw new Error(message);
}

async function run() {
  let shuttingDown = false;
  const coordinator = new AgentInputCoordinator({ isShuttingDown: () => shuttingDown });
  const events: string[] = [];
  let releaseFirst!: () => void;
  const first = coordinator.enqueue('agent-1', async () => {
    events.push('first-start');
    await new Promise<void>(resolve => { releaseFirst = resolve; });
    events.push('first-end');
  });
  const second = coordinator.enqueue('agent-1', () => {
    events.push('second');
  });
  const other = coordinator.enqueue('agent-2', () => {
    events.push('other');
  });
  await waitFor(() => events.includes('other'), 'unrelated Agent input did not run independently');
  assert.deepStrictEqual(events, ['first-start', 'other']);
  assert.strictEqual(coordinator.pendingOperations().size, 2);
  releaseFirst();
  await Promise.all([first, second, other]);
  assert.deepStrictEqual(events, ['first-start', 'other', 'first-end', 'second']);
  assert.strictEqual(coordinator.pendingOperations().size, 0);

  let releaseBoundary!: () => void;
  let finishDelivery!: () => void;
  const delivery = coordinator.enqueueUntilReleased('agent-3', async release => {
    events.push('delivery-start');
    releaseBoundary = release;
    await new Promise<void>(resolve => { finishDelivery = resolve; });
    events.push('delivery-end');
  });
  const following = coordinator.enqueue('agent-3', () => {
    events.push('following');
  });
  await waitFor(() => Boolean(releaseBoundary), 'released input did not start');
  releaseBoundary();
  await waitFor(() => events.includes('following'), 'release did not advance the queue');
  assert(!events.includes('delivery-end'), 'release must not require operation completion');
  finishDelivery();
  await Promise.all([delivery, following]);

  await assert.rejects(
    coordinator.enqueue('agent-4', () => Promise.reject(new Error('failed input'))),
    /failed input/,
  );
  await coordinator.enqueue('agent-4', () => { events.push('after-failure'); });
  assert(events.includes('after-failure'), 'a failed input must not poison its Agent queue');

  shuttingDown = true;
  await assert.rejects(
    coordinator.enqueue('agent-5', () => {}),
    /shutting down/,
  );
  await coordinator.enqueue('agent-5', () => { events.push('admitted'); }, { admitted: true });
  assert(events.includes('admitted'));
  await assert.rejects(
    coordinator.enqueueUntilReleased('agent-6', () => {}),
    /shutting down/,
  );
  coordinator.dispose();
}

run().then(() => {
  console.log('agent input coordinator tests passed');
}).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
