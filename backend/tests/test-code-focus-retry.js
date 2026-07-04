const assert = require('assert');
const { scheduleFocusRetries } = require('../../src/components/code/focus-retry.ts');

function createScheduler() {
  let nextHandle = 1;
  const frames = new Map();
  const timers = new Map();
  const cancelledFrames = [];
  const clearedTimers = [];

  return {
    scheduler: {
      requestAnimationFrame(callback) {
        const handle = nextHandle++;
        frames.set(handle, callback);
        return handle;
      },
      cancelAnimationFrame(handle) {
        cancelledFrames.push(handle);
        frames.delete(handle);
      },
      setTimeout(callback, delay) {
        const handle = nextHandle++;
        timers.set(handle, { callback, delay });
        return handle;
      },
      clearTimeout(handle) {
        clearedTimers.push(handle);
        timers.delete(handle);
      },
    },
    frames,
    timers,
    cancelledFrames,
    clearedTimers,
  };
}

function run() {
  const state = createScheduler();
  let focusCount = 0;

  const cleanup = scheduleFocusRetries(() => {
    focusCount += 1;
  }, { delays: [0, 80, 180] }, state.scheduler);

  assert.strictEqual(focusCount, 1, 'focus should run immediately by default');
  assert.strictEqual(state.frames.size, 1, 'focus should also be scheduled on the next animation frame');
  assert.deepStrictEqual(
    Array.from(state.timers.values()).map(timer => timer.delay),
    [0, 80, 180],
    'focus retry delays should be explicit and ordered'
  );

  cleanup();
  assert.strictEqual(state.frames.size, 0, 'cleanup should cancel pending animation frame');
  assert.strictEqual(state.timers.size, 0, 'cleanup should clear pending retry timers');
  assert.deepStrictEqual(state.cancelledFrames, [1]);
  assert.deepStrictEqual(state.clearedTimers, [2, 3, 4]);

  const delayedState = createScheduler();
  let delayedFocusCount = 0;
  scheduleFocusRetries(() => {
    delayedFocusCount += 1;
  }, { runNow: false, animationFrame: false, delays: [180] }, delayedState.scheduler);

  assert.strictEqual(delayedFocusCount, 0, 'runNow false should only schedule retries');
  assert.strictEqual(delayedState.frames.size, 0, 'animationFrame false should skip frame scheduling');
  assert.deepStrictEqual(Array.from(delayedState.timers.values()).map(timer => timer.delay), [180]);

  console.log('test-code-focus-retry passed');
}

run();
