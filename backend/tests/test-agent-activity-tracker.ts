const assert = require('assert');

const { AgentActivityTracker, agentActivityLevel } = require('../agent-activity-tracker.cjs');

function run() {
  const published = [];
  const tracker = new AgentActivityTracker({
    publish: (agentId, activityAt) => published.push({ agentId, activityAt }),
  });
  tracker.record('agent-1', 1_000);
  assert.strictEqual(tracker.get('agent-1', 0), 1_000);
  assert.strictEqual(tracker.publish('agent-1', 1_500), true);
  assert.strictEqual(tracker.publish('agent-1', 2_000), false);
  assert.strictEqual(tracker.publish('agent-1', 2_500), true);
  assert.deepStrictEqual(published, [
    { agentId: 'agent-1', activityAt: 1_500 },
    { agentId: 'agent-1', activityAt: 2_500 },
  ]);
  assert.strictEqual(tracker.get('agent-1', 0), 2_500, 'throttled publication still records activity');
  assert.strictEqual(agentActivityLevel(0, 1_000), 'hot');
  assert.strictEqual(agentActivityLevel(0, 31 * 60 * 1_000), 'warm');
  assert.strictEqual(agentActivityLevel(0, 4 * 60 * 60 * 1_000), 'cool');
  assert.strictEqual(agentActivityLevel(0, 13 * 60 * 60 * 1_000), 'cold');
  tracker.forget('agent-1');
  assert.strictEqual(tracker.get('agent-1', 99), 99);
  tracker.dispose();
}

try {
  run();
  console.log('agent activity tracker tests passed');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
