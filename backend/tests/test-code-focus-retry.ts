const assert = require('assert');
const {
  scheduleFocusRetries,
  scheduleFocusUntil,
  scheduleUserCancelableFocusRetries,
} = require('../../src/components/code/focus-retry.ts');

function createScheduler() {
  let nextHandle = 1;
  const frames = new Map();
  const timers = new Map();
  const add = (entries, value) => {
    const handle = nextHandle++;
    entries.set(handle, value);
    return handle;
  };

  return {
    frames,
    timers,
    scheduler: {
      requestAnimationFrame: callback => add(frames, callback),
      cancelAnimationFrame(handle) {
        frames.delete(handle);
      },
      setTimeout: (callback, delay) => add(timers, { callback, delay }),
      clearTimeout(handle) {
        timers.delete(handle);
      },
    },
  };
}

function runNext(entries) {
  const [handle, value] = entries.entries().next().value || [];
  if (!handle) return false;
  entries.delete(handle);
  (value.callback || value)();
  return true;
}

function createIntentTarget() {
  const listeners = new Map();
  return {
    target: {
      addEventListener(type, listener) {
        const current = listeners.get(type) || new Set();
        current.add(listener);
        listeners.set(type, current);
      },
      removeEventListener(type, listener) {
        listeners.get(type)?.delete(listener);
      },
    },
    dispatch(type) {
      [...(listeners.get(type) || [])].forEach(listener => listener({ type }));
    },
    listenerCount() {
      return [...listeners.values()].reduce((count, current) => count + current.size, 0);
    },
  };
}

function run() {
  const retries = createScheduler();
  let focusCount = 0;
  const cleanup = scheduleFocusRetries(
    () => { focusCount += 1; },
    { delays: [0, 80, 180] },
    retries.scheduler,
  );
  assert.strictEqual(focusCount, 1);
  assert.deepStrictEqual([...retries.timers.values()].map(timer => timer.delay), [0, 80, 180]);
  cleanup();
  assert.strictEqual(retries.frames.size + retries.timers.size, 0);

  const userCancelable = createScheduler();
  const userIntent = createIntentTarget();
  let userCancelableFocusCount = 0;
  scheduleUserCancelableFocusRetries(
    () => { userCancelableFocusCount += 1; },
    { runNow: false, animationFrame: false, delays: [80, 180] },
    userIntent.target,
    userCancelable.scheduler,
  );
  assert.strictEqual(userIntent.listenerCount(), 2);
  runNext(userCancelable.timers);
  assert.strictEqual(userCancelableFocusCount, 1);
  userIntent.dispatch('pointerdown');
  assert.strictEqual(userIntent.listenerCount(), 0);
  assert.strictEqual(userCancelable.timers.size, 0);

  const uninterrupted = createScheduler();
  const uninterruptedIntent = createIntentTarget();
  let uninterruptedFocusCount = 0;
  scheduleUserCancelableFocusRetries(
    () => { uninterruptedFocusCount += 1; },
    { runNow: false, animationFrame: false, delays: [80, 180] },
    uninterruptedIntent.target,
    uninterrupted.scheduler,
  );
  while (runNext(uninterrupted.timers)) {
    // Drain focus retries and the bounded listener cleanup.
  }
  assert.strictEqual(uninterruptedFocusCount, 2);
  assert.strictEqual(uninterruptedIntent.listenerCount(), 0);

  const delayed = createScheduler();
  scheduleFocusRetries(() => assert.fail('delayed focus ran early'), {
    runNow: false, animationFrame: false, delays: [180],
  }, delayed.scheduler);
  assert.strictEqual(delayed.timers.values().next().value.delay, 180);

  const until = createScheduler();
  let untilAttempts = 0;
  scheduleFocusUntil(
    () => (untilAttempts += 1) === 2,
    { initialDelay: 50, retryDelay: 90, maxAttempts: 4 },
    until.scheduler,
  );
  assert.strictEqual(until.timers.values().next().value.delay, 50);
  runNext(until.timers);
  runNext(until.frames);
  assert.strictEqual(until.timers.values().next().value.delay, 90);
  runNext(until.timers);
  runNext(until.frames);
  assert.strictEqual(untilAttempts, 2);
  assert.strictEqual(until.timers.size + until.frames.size, 0);

  const capped = createScheduler();
  let cappedAttempts = 0;
  scheduleFocusUntil(
    () => { cappedAttempts += 1; return false; },
    { maxAttempts: 2, animationFrame: false },
    capped.scheduler,
  );
  while (runNext(capped.timers)) {
    // Drain every scheduled retry.
  }
  assert.strictEqual(cappedAttempts, 2);

  console.log('test-code-focus-retry passed');
}

run();
