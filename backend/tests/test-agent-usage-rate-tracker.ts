const assert = require('assert');
const { AgentUsageRateTracker } = require('../agent-usage-rate-tracker.cjs');

async function run() {
  const originalDateNow = Date.now;
  let clockNow = 1_000_000;
  Date.now = () => clockNow;

  try {
    const windowMs = 5 * 60 * 1000;
    const tracker = new AgentUsageRateTracker();
    const now = clockNow;

    tracker.record('agent-1', 40, now - 10_000);
    const firstRate = tracker.getRate('agent-1', { now, windowMs });
    assert.strictEqual(firstRate.outputBytes, 40);

    tracker.record('agent-1', 20, now);
    assert.strictEqual(
      tracker.getRate('agent-1', { now: now + 4999, windowMs }),
      firstRate,
      'a read inside the five-second refresh window must reuse the cached value',
    );

    const refreshedRate = tracker.getRate('agent-1', { now: now + 5000, windowMs });
    assert.notStrictEqual(refreshedRate, firstRate, 'the cache must expire after five seconds');
    assert.strictEqual(refreshedRate.outputBytes, 60);

    const narrowRate = tracker.getRate('agent-1', { now: now + 5000, windowMs: 60_000 });
    assert.notStrictEqual(narrowRate, refreshedRate, 'a different window must not read the cache');
    assert.strictEqual(narrowRate.windowMs, 60_000);
    const rewidenedRate = tracker.getRate('agent-1', { now: now + 5000, windowMs });
    assert.notStrictEqual(
      rewidenedRate,
      refreshedRate,
      'the single cache entry belongs to the last requested window',
    );
    assert.strictEqual(rewidenedRate.windowMs, windowMs);
    assert.strictEqual(rewidenedRate.outputBytes, 60);

    const backwardsRate = tracker.getRate('agent-1', { now: now + 4000, windowMs });
    assert.notStrictEqual(
      backwardsRate,
      rewidenedRate,
      'a clock that moves backwards must invalidate the cached sample',
    );
    assert.strictEqual(backwardsRate.sampledAt, now + 4000);

    tracker.record('retain-agent', 4, now);
    tracker.record('retain-agent', 6, now + 1000);
    assert.deepStrictEqual(
      tracker.getActivityTotals('retain-agent', { cutoff: now }),
      { bytes: 10, eventCount: 2 },
      'an inclusive cutoff must count activity landing exactly on the cutoff',
    );
    assert.deepStrictEqual(
      tracker.getActivityTotals('retain-agent', { cutoff: now, inclusiveCutoff: false }),
      { bytes: 6, eventCount: 1 },
      'an exclusive cutoff must drop activity landing exactly on the cutoff',
    );
    const retainedRate = tracker.calculateRate('retain-agent', { now: now + 1000, windowMs });
    assert.strictEqual(retainedRate.outputBytes, 10);
    assert.deepStrictEqual(
      tracker.getActivityTotals('retain-agent', { cutoff: now }),
      { bytes: 10, eventCount: 2 },
      'a read inside the window must retain every event it counted',
    );

    clockNow = now + windowMs + 20_000;
    const evictedRate = tracker.calculateRate('retain-agent', { now: clockNow, windowMs });
    assert.strictEqual(evictedRate.outputBytes, 0);
    assert.deepStrictEqual(
      tracker.getActivityTotals('retain-agent', { cutoff: 0 }),
      { bytes: 0, eventCount: 0 },
      'an empty projection must leave no retained activity for the Agent',
    );

    clockNow = now;
    tracker.record('forget-agent', 100, now);
    const beforeForget = tracker.getRate('forget-agent', { now, windowMs });
    assert.strictEqual(beforeForget.outputBytes, 100);
    tracker.forget('forget-agent');
    tracker.forget('forget-agent');
    assert.deepStrictEqual(
      tracker.getActivityTotals('forget-agent', { cutoff: 0 }),
      { bytes: 0, eventCount: 0 },
    );
    const afterForget = tracker.getRate('forget-agent', { now, windowMs });
    assert.notStrictEqual(afterForget, beforeForget, 'forget must drop the cached rate');
    assert.strictEqual(afterForget.outputBytes, 0);
    assert.strictEqual(afterForget.eventCount, 0);
    assert.strictEqual(afterForget.sampledAt, now);

    const coldRate = tracker.getRate('unknown-agent', { now, windowMs });
    assert.strictEqual(coldRate.outputBytes, 0);
    assert.strictEqual(coldRate.eventCount, 0);
    assert.strictEqual(coldRate.windowMs, windowMs);
    assert.deepStrictEqual(
      tracker.getActivityTotals('unknown-agent', { cutoff: 0 }),
      { bytes: 0, eventCount: 0 },
    );

    console.log('✓ agent usage-rate tracker owns bounded buckets, the rate cache, and forget');
  } finally {
    Date.now = originalDateNow;
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
