import assert from 'assert';
import { MainAgentIdentityOwner } from '../main-agent-identity-owner.cjs';

async function main() {
  const owner = new MainAgentIdentityOwner();
  assert.strictEqual(owner.currentId(), null);
  assert.strictEqual(owner.hasCurrent(), false);

  assert.deepStrictEqual(owner.setCurrent('main-a'), {
    changed: true,
    currentId: 'main-a',
    previousId: null,
  });
  assert.strictEqual(owner.isCurrent('main-a'), true);
  assert.strictEqual(owner.hasCurrent(), true);
  assert.deepStrictEqual(owner.setCurrent('main-a'), {
    changed: false,
    currentId: 'main-a',
    previousId: 'main-a',
  });
  assert.deepStrictEqual(owner.clearIf('other'), {
    changed: false,
    currentId: 'main-a',
    previousId: 'main-a',
  });
  assert.deepStrictEqual(owner.clearIf('main-a'), {
    changed: true,
    currentId: null,
    previousId: 'main-a',
  });

  const first = owner.beginStart();
  const joined = owner.beginStart();
  assert.strictEqual(first.owner, true);
  assert.strictEqual(joined.owner, false);
  assert.strictEqual(joined.promise, first.promise);

  const outcome = { agentId: 'main-b', error: null };
  first.complete(outcome);
  assert.deepStrictEqual(await joined.promise, outcome);

  first.complete({ agentId: null, error: 'must be ignored' });
  assert.deepStrictEqual(await first.promise, outcome);

  const next = owner.beginStart();
  assert.strictEqual(next.owner, true);
  assert.notStrictEqual(next.promise, first.promise);
  next.complete({ agentId: null, error: 'start failed' });
  assert.deepStrictEqual(await next.promise, { agentId: null, error: 'start failed' });

  console.log('Main Agent identity owner tests passed');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
