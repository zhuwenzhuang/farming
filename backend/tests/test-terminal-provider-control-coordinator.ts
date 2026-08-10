import assert from 'assert';
import { TerminalProviderControlCoordinator } from '../terminal-provider-control-coordinator.cjs';

async function main() {
  const coordinator = new TerminalProviderControlCoordinator();
  let resolveIdentity!: (value: boolean) => void;
  let identityRuns = 0;
  const identity = coordinator.resolveIdentityOnce('agent-a', 'epoch-1', () => {
    identityRuns += 1;
    return new Promise<boolean>(resolve => {
      resolveIdentity = resolve;
    });
  });
  const joinedIdentity = coordinator.resolveIdentityOnce('agent-a', 'epoch-1', async () => {
    identityRuns += 1;
    return false;
  });
  assert.strictEqual(identity, joinedIdentity);
  assert.strictEqual(identityRuns, 1);
  resolveIdentity(true);
  assert.strictEqual(await identity, true);
  assert.strictEqual(
    await coordinator.resolveIdentityOnce('agent-a', 'epoch-1', async () => true),
    false,
    'one runtime epoch should not repeat an exhausted identity attempt',
  );
  coordinator.resetIdentityAttempt('agent-a', 'epoch-1');
  assert.strictEqual(
    await coordinator.resolveIdentityOnce('agent-a', 'epoch-1', async () => true),
    true,
  );

  let releaseProfile!: () => void;
  const profileGate = new Promise<void>(resolve => {
    releaseProfile = resolve;
  });
  const order: string[] = [];
  const firstProfile = coordinator.runProfileMutation('agent-a', async () => {
    order.push('first:start');
    await profileGate;
    order.push('first:end');
  });
  const secondProfile = coordinator.runProfileMutation('agent-a', async () => {
    order.push('second');
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepStrictEqual(order, ['first:start']);
  releaseProfile();
  await Promise.all([firstProfile, secondProfile]);
  assert.deepStrictEqual(order, ['first:start', 'first:end', 'second']);
  assert.deepStrictEqual(coordinator.pendingOperations(), []);

  console.log('Terminal provider control coordinator tests passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
