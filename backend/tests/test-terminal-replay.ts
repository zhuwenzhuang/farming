const assert = require('assert');

const TERMINAL_REPLAY = require('../../frontend/terminal-replay.js');

const epoch = 'farming-runtime-v1:00000000000000000001:test';

function checkpoint(stateRevision, outputSeq = stateRevision) {
  return { runtimeEpoch: epoch, stateRevision, outputSeq, cols: 80, rows: 24 };
}

function output(stateRevision, outputSeq = stateRevision) {
  return { kind: 'output', data: `revision-${stateRevision}`, runtimeEpoch: epoch, stateRevision, outputSeq };
}

function run() {
  const composed = TERMINAL_REPLAY.createState();
  TERMINAL_REPLAY.commitCheckpoint(composed, checkpoint(1));
  TERMINAL_REPLAY.beginRecovery(composed, output(2));
  TERMINAL_REPLAY.queueTransition(composed, output(3));

  assert.deepStrictEqual(
    TERMINAL_REPLAY.evaluateCheckpoint(composed, checkpoint(2)),
    { action: 'install' },
    'a checkpoint may compose with a complete contiguous queued suffix',
  );
  assert.strictEqual(TERMINAL_REPLAY.commitCheckpoint(composed, checkpoint(2)), true);
  assert.strictEqual(composed.recovering, false);
  assert.deepStrictEqual(TERMINAL_REPLAY.takeQueuedTransition(composed), output(3));

  const gapped = TERMINAL_REPLAY.createState();
  TERMINAL_REPLAY.commitCheckpoint(gapped, checkpoint(1));
  TERMINAL_REPLAY.beginRecovery(gapped, output(2));
  TERMINAL_REPLAY.queueTransition(gapped, output(4));
  assert.strictEqual(
    TERMINAL_REPLAY.evaluateCheckpoint(gapped, checkpoint(2)).action,
    'reject',
    'a checkpoint must remain rejected when its queued suffix has a gap',
  );

  const wrongOutputSeq = TERMINAL_REPLAY.createState();
  TERMINAL_REPLAY.commitCheckpoint(wrongOutputSeq, checkpoint(1));
  TERMINAL_REPLAY.beginRecovery(wrongOutputSeq, output(2));
  TERMINAL_REPLAY.queueTransition(wrongOutputSeq, output(3, 4));
  assert.strictEqual(
    TERMINAL_REPLAY.evaluateCheckpoint(wrongOutputSeq, checkpoint(2)).action,
    'reject',
    'a checkpoint must remain rejected when its queued output sequence is not contiguous',
  );

  console.log('✓ terminal replay composes checkpoints only with a complete queued suffix');
}

run();
