import assert from 'assert';
import { ProjectOperationAdmissionCoordinator } from '../project-operation-admission-coordinator.cjs';

async function main() {
  const coordinator = new ProjectOperationAdmissionCoordinator();
  let releaseRequest!: () => void;
  const requestGate = new Promise<void>(resolve => {
    releaseRequest = resolve;
  });
  let requestRuns = 0;
  const operation = async () => {
    requestRuns += 1;
    await requestGate;
    return { workspace: '/repo/a' };
  };
  const first = coordinator.runRequest('request-a', '/repo', operation);
  const duplicate = coordinator.runRequest('request-a', '/repo', operation);
  assert.strictEqual(first, duplicate);
  await assert.rejects(
    coordinator.runRequest('request-a', '/other', operation),
    /different parameters/,
  );
  assert.strictEqual(requestRuns, 1);
  assert.strictEqual(coordinator.pendingOperations().length, 1);
  releaseRequest();
  assert.deepStrictEqual(await first, { workspace: '/repo/a' });

  let releaseDelete!: () => void;
  const deleteGate = new Promise<void>(resolve => {
    releaseDelete = resolve;
  });
  const order: string[] = [];
  const deleteA = coordinator.runExclusive('/repo/a', 'delete-a', async () => {
    order.push('a:start');
    await deleteGate;
    order.push('a:end');
    return 'a';
  });
  const duplicateDelete = coordinator.runExclusive('/repo/a', 'delete-a', async () => 'duplicate');
  assert.strictEqual(deleteA, duplicateDelete);
  const queuedDelete = coordinator.runExclusive('/repo/a', 'delete-b', async () => {
    order.push('b:start');
    return 'b';
  });
  assert.strictEqual(
    coordinator.findExclusiveKey('/repo/a/child', (root, candidate) => candidate.startsWith(root)),
    '/repo/a',
  );
  releaseDelete();
  assert.strictEqual(await deleteA, 'a');
  assert.strictEqual(await queuedDelete, 'b');
  assert.deepStrictEqual(order, ['a:start', 'a:end', 'b:start']);
  assert.deepStrictEqual(coordinator.pendingOperations(), []);

  console.log('Project operation admission coordinator tests passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
