import assert from 'assert';
import { ProviderSessionMutationCoordinator } from '../provider-session-mutation-coordinator.cjs';

async function main() {
  const coordinator = new ProviderSessionMutationCoordinator();
  let release!: () => void;
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  const order: string[] = [];
  const archive = coordinator.run({
    provider: 'codex',
    homeId: 'default',
    sessionId: 'session-a',
    type: 'archive',
    operation: async () => {
      order.push('archive:start');
      await gate;
      order.push('archive:end');
      return 'archived';
    },
  });
  const joinedArchive = coordinator.run({
    provider: 'codex',
    homeId: 'default',
    sessionId: 'session-a',
    type: 'archive',
    joinSameType: true,
    operation: async () => 'duplicate',
  });
  assert.strictEqual(archive, joinedArchive);
  const unarchive = coordinator.run({
    provider: 'codex',
    homeId: 'default',
    sessionId: 'session-a',
    type: 'unarchive',
    operation: async () => {
      order.push('unarchive');
      return 'unarchived';
    },
  });
  const otherProvider = coordinator.run({
    provider: 'claude',
    homeId: 'default',
    sessionId: 'session-a',
    type: 'archive',
    operation: async () => {
      order.push('claude');
      return 'isolated';
    },
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepStrictEqual(order, ['archive:start', 'claude']);
  release();
  assert.strictEqual(await archive, 'archived');
  assert.strictEqual(await unarchive, 'unarchived');
  assert.strictEqual(await otherProvider, 'isolated');
  assert.deepStrictEqual(order, ['archive:start', 'claude', 'archive:end', 'unarchive']);
  assert.deepStrictEqual(coordinator.pendingOperations(), []);

  console.log('Provider session mutation coordinator tests passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
