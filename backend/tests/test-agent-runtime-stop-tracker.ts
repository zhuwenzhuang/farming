import assert from 'assert';
import { AgentRuntimeStopTracker } from '../agent-runtime-stop-tracker.cjs';

function main() {
  const tracker = new AgentRuntimeStopTracker();
  assert.strictEqual(tracker.isVerifiedStopped('agent-a'), false);
  assert.strictEqual(tracker.exitEventsSuppressed('agent-a'), false);

  const release = tracker.suppressExitEvents('agent-a');
  assert.strictEqual(tracker.exitEventsSuppressed('agent-a'), true);
  release();
  release();
  assert.strictEqual(tracker.exitEventsSuppressed('agent-a'), false);

  tracker.markVerifiedStopped('agent-a');
  assert.strictEqual(tracker.isVerifiedStopped('agent-a'), true);
  tracker.suppressExitEvents('agent-a');
  tracker.forget('agent-a');
  assert.strictEqual(tracker.isVerifiedStopped('agent-a'), false);
  assert.strictEqual(tracker.exitEventsSuppressed('agent-a'), false);

  console.log('Agent runtime stop tracker tests passed');
}

main();
