const assert = require('assert');

const { TerminalResizeCoordinator } = require('../terminal-resize-coordinator.cjs');

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
  let releaseFirst!: () => void;
  const calls: Array<{ agentId: string; cols: number; rows: number }> = [];
  const coordinator = new TerminalResizeCoordinator({
    isShuttingDown: () => shuttingDown,
    resize: async (agentId, size) => {
      calls.push({ agentId, ...size });
      if (agentId === 'agent-1' && calls.filter(call => call.agentId === agentId).length === 1) {
        await new Promise<void>(resolve => { releaseFirst = resolve; });
      }
    },
  });

  assert.strictEqual(coordinator.request('agent-1', 80, 24), true);
  await waitFor(() => Boolean(releaseFirst), 'first resize did not begin');
  coordinator.request('agent-1', 100, 30);
  coordinator.request('agent-1', 120, 40);
  coordinator.request('agent-2', 90, 25);
  await waitFor(
    () => calls.some(call => call.agentId === 'agent-2'),
    'unrelated Agent resize did not run independently',
  );
  await waitFor(
    () => coordinator.pendingOperations().size === 1,
    'completed unrelated resize remained in the drain set',
  );
  releaseFirst();
  await Promise.all(coordinator.pendingOperations());
  assert.deepStrictEqual(
    calls.filter(call => call.agentId === 'agent-1'),
    [
      { agentId: 'agent-1', cols: 80, rows: 24 },
      { agentId: 'agent-1', cols: 120, rows: 40 },
    ],
    'waiting resize requests must coalesce to the newest dimensions',
  );
  assert.strictEqual(coordinator.pendingOperations().size, 0);

  shuttingDown = true;
  assert.strictEqual(coordinator.request('agent-3', 80, 24), false);
  assert.strictEqual(coordinator.pendingOperations().size, 0);
  coordinator.dispose();
}

run().then(() => {
  console.log('terminal resize coordinator tests passed');
}).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
