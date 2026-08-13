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

  const overlaps = (left: string, right: string) => (
    left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`)
  );
  let releaseNested!: () => void;
  const nestedGate = new Promise<void>(resolve => {
    releaseNested = resolve;
  });
  const overlapOrder: string[] = [];
  const nested = coordinator.runExclusive('/repo/a/nested', 'nested', async () => {
    overlapOrder.push('nested:start');
    await nestedGate;
    overlapOrder.push('nested:end');
  }, overlaps);
  const ancestor = coordinator.runExclusive('/repo/a', 'ancestor', async () => {
    overlapOrder.push('ancestor:start');
  }, overlaps);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepStrictEqual(overlapOrder, ['nested:start']);
  releaseNested();
  await Promise.all([nested, ancestor]);
  assert.deepStrictEqual(overlapOrder, ['nested:start', 'nested:end', 'ancestor:start']);
  assert.deepStrictEqual(coordinator.pendingOperations(), []);

  let releaseFirstKind!: () => void;
  const firstKindGate = new Promise<void>(resolve => {
    releaseFirstKind = resolve;
  });
  const firstKind = coordinator.runExclusive('/repo/a', 'shared-request', async () => {
    await firstKindGate;
    return 'switch';
  }, overlaps, 'switch-signature');
  const secondKind = coordinator.runExclusive('/repo/a', 'shared-request', async () => (
    'delete'
  ), overlaps, 'delete-signature');
  await assert.rejects(secondKind, /different parameters/);
  releaseFirstKind();
  assert.strictEqual(await firstKind, 'switch');

  let releaseDeleteKind!: () => void;
  const deleteKindGate = new Promise<void>(resolve => {
    releaseDeleteKind = resolve;
  });
  const deleteKind = coordinator.runExclusive('/repo/a', 'reverse-request', async () => {
    await deleteKindGate;
    return 'delete';
  }, overlaps, 'delete-signature');
  const reverseSwitchKind = coordinator.runExclusive('/repo/a/nested', 'reverse-request', async () => (
    'switch'
  ), overlaps, 'switch-signature');
  await assert.rejects(reverseSwitchKind, /different parameters/);
  releaseDeleteKind();
  assert.strictEqual(await deleteKind, 'delete');

  console.log('Project operation admission coordinator tests passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
