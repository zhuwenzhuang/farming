import assert from 'assert';
import { AgentTerminalProjectionTracker } from '../agent-terminal-projection-tracker.cjs';

function main() {
  const tracker = new AgentTerminalProjectionTracker<object, { status: string }>();
  const agent = {};
  assert.deepStrictEqual(
    tracker.previousStatus(agent, () => ({ status: 'fallback' })),
    { status: 'fallback' },
  );
  assert.deepStrictEqual(
    tracker.previousProviderProfile(agent, () => ({ model: 'fallback' })),
    { model: 'fallback' },
  );
  tracker.update(agent, { status: 'running' }, null);
  assert.deepStrictEqual(
    tracker.previousStatus(agent, () => ({ status: 'fallback' })),
    { status: 'running' },
  );
  assert.strictEqual(
    tracker.previousProviderProfile(agent, () => ({ model: 'fallback' })),
    null,
    'an observed null profile must not fall back to stale Agent metadata',
  );
  tracker.updateStatus(agent, { status: 'idle' });
  assert.deepStrictEqual(
    tracker.previousStatus(agent, () => ({ status: 'fallback' })),
    { status: 'idle' },
  );
  console.log('Agent terminal projection tracker tests passed');
}

main();
