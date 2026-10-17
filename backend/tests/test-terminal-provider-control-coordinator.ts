import assert from 'assert';
import { TerminalProviderControlCoordinator, observeTerminalIdentityReadiness, terminalIdentityProbeState } from '../terminal-provider-control-coordinator.cjs';

async function main() {
  assert.strictEqual(observeTerminalIdentityReadiness(null, 'epoch-1', false, true), null,
    'a startup composer is not proof of a configured provider Session');
  const working = observeTerminalIdentityReadiness(null, 'epoch-1', true, false);
  assert.deepStrictEqual(working, { runtimeEpoch: 'epoch-1', phase: 'working' });
  assert.strictEqual(observeTerminalIdentityReadiness(working, 'epoch-1', false, false), working,
    'menus and permission prompts cannot complete identity readiness');
  const recovered = JSON.parse(JSON.stringify(working));
  const ready = observeTerminalIdentityReadiness(recovered, 'epoch-1', false, true);
  assert.deepStrictEqual(ready, { runtimeEpoch: 'epoch-1', phase: 'ready' },
    'Server recovery retains an observed turn only for the same runtime epoch');
  assert.strictEqual(observeTerminalIdentityReadiness(ready, 'epoch-2', false, true), null);
  const attempted = { runtimeEpoch: 'epoch-1', phase: 'attempted' };
  assert.strictEqual(observeTerminalIdentityReadiness(attempted, 'epoch-1', true, false), attempted,
    'subsequent turns never replay an attempted status command');
  assert.strictEqual(terminalIdentityProbeState({ runtimeEpoch: 'epoch-1', phase: 'other' }, 'epoch-1'), null);
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
