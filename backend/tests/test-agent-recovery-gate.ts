import assert from 'assert';
import { AgentRecoveryGate } from '../agent-recovery-gate.cjs';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(next => {
    resolve = next;
  });
  return { promise, resolve };
}

async function main() {
  const gate = new AgentRecoveryGate();
  assert.strictEqual(gate.isComplete(), true);
  await gate.wait();

  const pending = deferred();
  gate.start(() => pending.promise);
  assert.strictEqual(gate.isComplete(), false);
  let released = false;
  const waiting = gate.wait().then(() => {
    released = true;
  });
  await Promise.resolve();
  assert.strictEqual(released, false);
  pending.resolve();
  await waiting;
  assert.strictEqual(gate.isComplete(), true);

  let observedFailure = '';
  gate.start(
    async () => {
      throw new Error('simulated recovery failure');
    },
    error => {
      observedFailure = error instanceof Error ? error.message : String(error);
    },
  );
  await gate.settled();
  assert.strictEqual(observedFailure, 'simulated recovery failure');
  assert.strictEqual(gate.isComplete(), false);
  await assert.rejects(() => gate.wait(), /Agent lifecycle recovery failed: simulated recovery failure/);

  console.log('Agent recovery gate tests passed');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
