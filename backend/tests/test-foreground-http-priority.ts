const assert = require('assert');
const { importTsModule } = require('./helpers/import-ts-module');
const {
  foregroundHttpPriorityActive,
  requestForegroundHttpPriority,
  subscribeForegroundHttpPriority,
} = importTsModule('src/lib/foreground-http-priority.ts');

let calls = 0;
const unsubscribe = subscribeForegroundHttpPriority(() => {
  calls += 1;
});
requestForegroundHttpPriority();
assert.strictEqual(calls, 1, 'Foreground work must synchronously notify background request owners');
assert.strictEqual(foregroundHttpPriorityActive(), true, 'Foreground admission must hold a bounded window for later background timers');
unsubscribe();
requestForegroundHttpPriority();
assert.strictEqual(calls, 1, 'Released request owners must not receive later foreground admissions');

console.log('foreground HTTP priority tests passed');
