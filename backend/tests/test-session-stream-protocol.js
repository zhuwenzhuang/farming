const assert = require('assert');
const {
  coalesceSessionStream,
  normalizeSessionStream,
} = require('../session-stream-protocol');

function run() {
  const first = normalizeSessionStream({
    agentId: 'agent-1',
    data: 'one',
    runtimeEpoch: 'epoch-a',
    outputSeq: 1,
    stateRevision: 1,
  });
  const second = coalesceSessionStream(first, {
    agentId: 'agent-1',
    data: 'two',
    runtimeEpoch: 'epoch-a',
    outputSeq: 2,
    stateRevision: 2,
  });
  assert.strictEqual(second.data, 'onetwo');
  assert.strictEqual(second.replace, false);
  assert.deepStrictEqual(second.chunks, [
    {
      kind: 'output',
      data: 'one',
      runtimeEpoch: 'epoch-a',
      outputSeq: 1,
      stateRevision: 1,
      cols: undefined,
      rows: undefined,
    },
    {
      kind: 'output',
      data: 'two',
      runtimeEpoch: 'epoch-a',
      outputSeq: 2,
      stateRevision: 2,
      cols: undefined,
      rows: undefined,
    },
  ]);

  const checkpointThenDelta = coalesceSessionStream({
    agentId: 'agent-1',
    sessionSource: 'terminal',
    data: 'serialized-checkpoint',
    replace: true,
    runtimeEpoch: 'epoch-a',
    outputSeq: 8,
    stateRevision: 11,
    cols: 132,
    rows: 41,
  }, {
    agentId: 'agent-1',
    sessionSource: 'terminal',
    data: 'tail',
    runtimeEpoch: 'epoch-a',
    outputSeq: 9,
    stateRevision: 12,
  });
  assert.strictEqual(checkpointThenDelta.data, 'serialized-checkpoint');
  assert.strictEqual(checkpointThenDelta.replace, true);
  assert.strictEqual(checkpointThenDelta.runtimeEpoch, 'epoch-a');
  assert.strictEqual(checkpointThenDelta.outputSeq, 8);
  assert.strictEqual(checkpointThenDelta.stateRevision, 11);
  assert.strictEqual(checkpointThenDelta.cols, 132);
  assert.strictEqual(checkpointThenDelta.rows, 41);
  assert.strictEqual(checkpointThenDelta.chunks.length, 1);
  assert.strictEqual(checkpointThenDelta.chunks[0].data, 'tail');
  assert.strictEqual(checkpointThenDelta.chunks[0].stateRevision, 12);

  const mixedTransitions = coalesceSessionStream(second, {
    agentId: 'agent-1',
    kind: 'resize',
    data: '',
    runtimeEpoch: 'epoch-a',
    outputSeq: 2,
    stateRevision: 3,
    cols: 100,
    rows: 30,
  });
  const afterResize = coalesceSessionStream(mixedTransitions, {
    agentId: 'agent-1',
    kind: 'clear',
    data: '\x1b[2J\x1b[3J\x1b[H',
    runtimeEpoch: 'epoch-a',
    outputSeq: 2,
    stateRevision: 4,
    cols: 100,
    rows: 30,
  });
  assert.deepStrictEqual(
    afterResize.chunks.map(chunk => ({
      kind: chunk.kind,
      outputSeq: chunk.outputSeq,
      stateRevision: chunk.stateRevision,
      cols: chunk.cols,
      rows: chunk.rows,
    })),
    [
      { kind: 'output', outputSeq: 1, stateRevision: 1, cols: undefined, rows: undefined },
      { kind: 'output', outputSeq: 2, stateRevision: 2, cols: undefined, rows: undefined },
      { kind: 'resize', outputSeq: 2, stateRevision: 3, cols: 100, rows: 30 },
      { kind: 'clear', outputSeq: 2, stateRevision: 4, cols: 100, rows: 30 },
    ],
    'coalescing must preserve output, resize, and clear transition boundaries',
  );

  const supersedingCheckpoint = coalesceSessionStream(second, {
    agentId: 'agent-1',
    data: 'new-checkpoint',
    replace: true,
    runtimeEpoch: 'epoch-a',
    outputSeq: 2,
    stateRevision: 3,
    cols: 100,
    rows: 30,
  });
  assert.strictEqual(supersedingCheckpoint.data, 'new-checkpoint');
  assert.strictEqual(supersedingCheckpoint.replace, true);
  assert.strictEqual(supersedingCheckpoint.stateRevision, 3);
  assert.strictEqual(supersedingCheckpoint.chunks, undefined);

  const staleCheckpoint = coalesceSessionStream(afterResize, {
    agentId: 'agent-1',
    data: 'stale-checkpoint',
    replace: true,
    runtimeEpoch: 'epoch-a',
    outputSeq: 1,
    stateRevision: 1,
    cols: 80,
    rows: 24,
  });
  assert.strictEqual(staleCheckpoint.data, 'stale-checkpoint');
  assert.strictEqual(staleCheckpoint.replace, true);
  assert.deepStrictEqual(
    staleCheckpoint.chunks.map(chunk => ({
      kind: chunk.kind,
      outputSeq: chunk.outputSeq,
      stateRevision: chunk.stateRevision,
    })),
    [
      { kind: 'output', outputSeq: 2, stateRevision: 2 },
      { kind: 'resize', outputSeq: 2, stateRevision: 3 },
      { kind: 'clear', outputSeq: 2, stateRevision: 4 },
    ],
    'a late stale checkpoint must preserve every already queued transition it does not cover',
  );

  const newerCheckpointThenStaleCheckpoint = coalesceSessionStream(checkpointThenDelta, {
    agentId: 'agent-1',
    data: 'older-checkpoint',
    replace: true,
    runtimeEpoch: 'epoch-a',
    outputSeq: 7,
    stateRevision: 10,
    cols: 100,
    rows: 30,
  });
  assert.strictEqual(
    newerCheckpointThenStaleCheckpoint.data,
    'serialized-checkpoint',
    'a stale checkpoint must not replace a newer checkpoint already queued for delivery',
  );
  assert.strictEqual(newerCheckpointThenStaleCheckpoint.stateRevision, 11);
  assert.strictEqual(newerCheckpointThenStaleCheckpoint.chunks[0].stateRevision, 12);

  const newEpoch = coalesceSessionStream(second, {
    agentId: 'agent-1',
    data: 'epoch-b-first',
    runtimeEpoch: 'epoch-b',
    outputSeq: 1,
    stateRevision: 1,
  });
  assert.strictEqual(newEpoch.data, 'epoch-b-first');
  assert.strictEqual(newEpoch.runtimeEpoch, 'epoch-b');
  assert.strictEqual(newEpoch.chunks.length, 1);

  const unprovedAfterCheckpoint = coalesceSessionStream(checkpointThenDelta, {
    agentId: 'agent-1',
    data: 'unproved',
    runtimeEpoch: 'epoch-a',
  });
  assert.strictEqual(unprovedAfterCheckpoint.data, 'unproved');
  assert.strictEqual(unprovedAfterCheckpoint.replace, false);
  assert.strictEqual(unprovedAfterCheckpoint.outputSeq, undefined);
  assert.strictEqual(unprovedAfterCheckpoint.stateRevision, undefined);
  assert.strictEqual(unprovedAfterCheckpoint.chunks, undefined);

  console.log('session stream protocol tests passed');
}

run();
