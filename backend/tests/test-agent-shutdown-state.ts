import assert from 'assert';
import { AgentShutdownState } from '../agent-shutdown-state.cjs';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, reject, resolve };
}

async function main() {
  const state = new AgentShutdownState();
  assert.strictEqual(state.isShuttingDown(), false);
  assert.strictEqual(state.isDisposed(), false);

  const first = deferred();
  let runs = 0;
  const disposing = state.run(() => {
    runs += 1;
    return first.promise;
  });
  const joined = state.run(async () => {
    runs += 1;
  });
  assert.strictEqual(joined, disposing);
  assert.strictEqual(state.isShuttingDown(), true);
  first.reject(new Error('pre-freeze failure'));
  await assert.rejects(() => disposing, /pre-freeze failure/);
  await Promise.resolve();
  assert.strictEqual(state.isShuttingDown(), false);
  assert.strictEqual(runs, 1);

  const frozenFailure = state.run(async () => {
    state.freeze();
    throw new Error('post-freeze failure');
  });
  await assert.rejects(() => frozenFailure, /post-freeze failure/);
  await Promise.resolve();
  assert.strictEqual(state.isShuttingDown(), true);
  assert.strictEqual(state.isDisposed(), false);

  await state.run(async () => {
    runs += 1;
    state.complete();
  });
  assert.strictEqual(state.isDisposed(), true);
  await state.run(async () => {
    runs += 1;
  });
  assert.strictEqual(runs, 2, 'disposed shutdown must not run cleanup again');

  console.log('Agent shutdown state tests passed');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
