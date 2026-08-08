const assert = require('assert');
const {
  AGENT_USAGE_RATE_WINDOW_MS,
  TERMINAL_OUTPUT_ACTIVITY_FUTURE_TOLERANCE_MS,
  agentUsageRateWindowMs,
  projectAgentUsageRate,
  recordTerminalOutputActivity,
  terminalOutputActivityTotals,
} = require('../agent-usage-rate.cjs');

async function run() {
  const originalDateNow = Date.now;
  let clockNow = 1_000_000;
  Date.now = () => clockNow;

  try {
    assert.strictEqual(agentUsageRateWindowMs(undefined), AGENT_USAGE_RATE_WINDOW_MS);
    assert.strictEqual(agentUsageRateWindowMs(Number.NaN), AGENT_USAGE_RATE_WINDOW_MS);
    assert.strictEqual(agentUsageRateWindowMs(0), AGENT_USAGE_RATE_WINDOW_MS);
    assert.strictEqual(agentUsageRateWindowMs(-500), AGENT_USAGE_RATE_WINDOW_MS);
    assert.strictEqual(agentUsageRateWindowMs('not-a-number'), AGENT_USAGE_RATE_WINDOW_MS);
    assert.strictEqual(agentUsageRateWindowMs(60_000), 60_000);
    assert.strictEqual(agentUsageRateWindowMs(1500.9), 1500);
    assert.strictEqual(agentUsageRateWindowMs(0.5), 1);
    assert.strictEqual(
      agentUsageRateWindowMs(10 * 60 * 1000),
      AGENT_USAGE_RATE_WINDOW_MS,
      'requested windows wider than retention must clamp to it',
    );

    const ordered = [];
    recordTerminalOutputActivity(ordered, clockNow, 100);
    recordTerminalOutputActivity(ordered, clockNow + 500, 25);
    assert.strictEqual(ordered.length, 1, 'same-second events must merge');
    assert.strictEqual(ordered[0].bytes, 125);
    assert.strictEqual(ordered[0].eventCount, 2);

    recordTerminalOutputActivity(ordered, clockNow + 1200, 40);
    assert.strictEqual(ordered.length, 2, 'the next second opens a new bucket');

    const disordered = [];
    clockNow = 2_005_000;
    recordTerminalOutputActivity(disordered, 2_004_000, 10);
    recordTerminalOutputActivity(disordered, 2_002_500, 20);
    recordTerminalOutputActivity(disordered, 2_002_900, 30);
    recordTerminalOutputActivity(disordered, 2_005_000, 40);
    assert.deepStrictEqual(
      disordered.map(bucket => bucket.bucketStartedAt),
      [2_002_000, 2_004_000, 2_005_000],
      'out-of-order events must retain time order',
    );
    assert.strictEqual(disordered[0].bytes, 50);

    const futureClamped = [];
    clockNow = 3_000_000;
    recordTerminalOutputActivity(futureClamped, clockNow + 60_000, 20);
    assert.strictEqual(
      futureClamped[0].lastEventAt,
      clockNow + TERMINAL_OUTPUT_ACTIVITY_FUTURE_TOLERANCE_MS,
      'future timestamps must clamp to the observation tolerance',
    );

    const retained = [];
    const retainedStartedAt = 4_000_000;
    for (let second = 0; second <= 600; second += 1) {
      clockNow = retainedStartedAt + second * 1000;
      recordTerminalOutputActivity(retained, clockNow, 1);
    }
    assert.strictEqual(
      retained.length,
      303,
      'ten minutes of output must keep only bounded five-minute retention',
    );

    const totalsBuckets = [];
    clockNow = 5_005_000;
    recordTerminalOutputActivity(totalsBuckets, 5_002_500, 20);
    recordTerminalOutputActivity(totalsBuckets, 5_003_500, 30);
    recordTerminalOutputActivity(totalsBuckets, 5_004_500, 40);
    assert.deepStrictEqual(
      terminalOutputActivityTotals(totalsBuckets, { cutoff: 5_003_500 }),
      { bytes: 70, eventCount: 2 },
      'the default inclusive cutoff keeps the bucket ending at the cutoff',
    );
    assert.deepStrictEqual(
      terminalOutputActivityTotals(totalsBuckets, {
        cutoff: 5_003_500,
        inclusiveCutoff: false,
      }),
      { bytes: 40, eventCount: 1 },
      'an exclusive cutoff drops the bucket ending at the cutoff',
    );

    const projectionInput = [
      {
        bucketStartedAt: 5_000_000,
        bytes: 100,
        eventCount: 1,
        firstEventAt: 5_000_000,
        lastEventAt: 5_000_000,
      },
      ...totalsBuckets,
      {
        bucketStartedAt: 5_007_000,
        bytes: 200,
        eventCount: 1,
        firstEventAt: 5_007_000,
        lastEventAt: 5_007_000,
      },
    ];
    const projectionSnapshot = JSON.parse(JSON.stringify(projectionInput));
    const projection = projectAgentUsageRate(projectionInput, {
      now: 5_005_000,
      windowMs: 2_000,
    });
    assert.deepStrictEqual(projectionInput, projectionSnapshot, 'projection must not mutate input');
    assert.deepStrictEqual(
      projection.retainedBuckets,
      projectionInput.slice(0, -1),
      'projection must exclude timestamps beyond the future tolerance',
    );
    assert.deepStrictEqual(projection.value, {
      windowMs: 2_000,
      outputBytes: 70,
      estimatedOutputTokens: 18,
      estimatedTokensPerMinute: 18,
      eventCount: 2,
      sampledAt: 5_005_000,
      source: 'terminal-output-estimate',
    });

    console.log('✓ agent usage-rate accounting is a bounded pure projection');
  } finally {
    Date.now = originalDateNow;
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
