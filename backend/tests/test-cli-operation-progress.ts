import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCliOperationProgress } from '../cli-operation-progress.cjs';

for (const [name, isTTY, env] of [
  ['terminal', true, { TERM: 'xterm' }],
  ['no color', true, { TERM: 'xterm', NO_COLOR: '' }],
  ['plain terminal', true, { TERM: 'dumb' }],
  ['log', false, { TERM: 'xterm' }],
] as const) {
  test(`lifecycle progress: ${name}, success and failure`, async () => {
    const chunks: string[] = [];
    const progress = createCliOperationProgress({
      env,
      stream: { isTTY, columns: 44, write: text => chunks.push(text) },
    });
    const result = await progress.step('Stopping the current instance and its Agents', async () => {
      await new Promise(resolve => setTimeout(resolve, 90));
      return 42;
    }, 'Stopped Farming and its Agents');
    assert.equal(result, 42);
    const failure = new Error('ownership could not be proven');
    await assert.rejects(progress.step('Starting Farming', async () => { throw failure; }, 'Ready'), error => error === failure);
    const output = chunks.join('');
    assert.match(output, /✓ Stopped Farming and its Agents · \d+\.\ds/);
    assert.match(output, /✗ Starting Farming failed/);
    assert.doesNotMatch(output, /✓ Ready/);
    if (!isTTY || env.TERM === 'dumb') assert.doesNotMatch(output, /\u001b/);
    if (name === 'no color') assert.doesNotMatch(output, /\u001b\[\d+m/);
    const count = chunks.length;
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(chunks.length, count, 'completed and failed steps must release their timers');
  });
}

test('a closed output stream does not replay or fail a successful operation', async () => {
  const progress = createCliOperationProgress({ stream: { write() { throw new Error('closed'); } } });
  let calls = 0;
  await progress.step('Stopping', async () => { calls++; }, 'Stopped');
  assert.equal(calls, 1);
});
