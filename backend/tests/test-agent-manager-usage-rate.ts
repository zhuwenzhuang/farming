const assert = require('assert');
const { AgentManager } = require('../agent-manager.cjs');

async function run() {
  const originalDateNow = Date.now;
  let clockNow = 1_000_000;
  Date.now = () => clockNow;
  const manager = new AgentManager({
    getWorkspace() {
      return process.cwd();
    },
    getHeartbeatInterval() {
      return 1000;
    },
    getCodingAgentEngine() {
      return 'local';
    },
    getVtBaseUrl() {
      return 'http://localhost:4020';
    },
  });

  try {
    const now = clockNow;
    const windowMs = 5 * 60 * 1000;
    manager.recordAgentOutputActivity('agent-1', 400, now - windowMs - 1);
    manager.recordAgentOutputActivity('agent-1', 40, now - 10_000);

    const activeRate = manager.calculateAgentUsageRate('agent-1', { now, windowMs });
    assert.strictEqual(activeRate.outputBytes, 40);
    assert.strictEqual(activeRate.estimatedOutputTokens, 10);
    assert.strictEqual(manager.outputActivityBuckets.get('agent-1').length, 1);

    const cachedRate = manager.getAgentUsageRate('agent-1', { now, windowMs });
    manager.recordAgentOutputActivity('agent-1', 20, now + 1000);
    const cachedRateBeforeRefresh = manager.getAgentUsageRate('agent-1', { now: now + 4999, windowMs });
    assert.strictEqual(cachedRateBeforeRefresh, cachedRate);
    assert.strictEqual(cachedRateBeforeRefresh.outputBytes, 40);

    const refreshedRate = manager.getAgentUsageRate('agent-1', { now: now + 5000, windowMs });
    assert.notStrictEqual(refreshedRate, cachedRate);
    assert.strictEqual(refreshedRate.outputBytes, 60);
    assert.strictEqual(refreshedRate.sampledAt, now + 5000);

    const idleRate = manager.getAgentUsageRate('agent-1', { now: now + windowMs + 20_000, windowMs });
    assert.strictEqual(idleRate.outputBytes, 0);
    assert.strictEqual(idleRate.estimatedOutputTokens, 0);
    assert.strictEqual(idleRate.estimatedTokensPerMinute, 0);
    assert.strictEqual(manager.outputActivityBuckets.has('agent-1'), false);

    manager.agents.set('agent-1', { id: 'agent-1', status: 'running' });
    manager.lastActivity.set('agent-1', now);
    const activity = manager.getAgentActivityPayload('agent-1', now + 1000);
    assert(activity);
    assert.strictEqual(activity.agentId, 'agent-1');
    assert.deepStrictEqual(manager.getAgentActivityPayloads(now + 1000), [activity]);

    const burstStartedAt = 2_000_000;
    clockNow = burstStartedAt + 9000;
    for (let index = 0; index < 100_000; index += 1) {
      manager.recordAgentOutputActivity(
        'burst-agent',
        4,
        burstStartedAt + Math.floor(index / 10_000) * 1000,
      );
    }
    assert.strictEqual(
      manager.outputActivityBuckets.get('burst-agent').length,
      10,
      '100,000 output chunks across ten seconds should occupy ten bounded buckets',
    );
    const burstRate = manager.calculateAgentUsageRate('burst-agent', {
      now: burstStartedAt + 9000,
      windowMs,
    });
    assert.strictEqual(burstRate.outputBytes, 400_000);
    assert.strictEqual(burstRate.eventCount, 100_000);
    manager.agents.set('burst-agent', { id: 'burst-agent', status: 'running' });
    manager.lastActivity.set('burst-agent', burstStartedAt + 9000);
    assert.strictEqual(
      manager.calculateAttentionScore('burst-agent', burstStartedAt + 9000),
      90,
      'bounded buckets should preserve the saturated output contribution to attention',
    );

    const boundedStartedAt = 3_000_000;
    clockNow = boundedStartedAt + 600_000;
    for (let second = 0; second <= 600; second += 1) {
      manager.recordAgentOutputActivity('bounded-agent', 1, boundedStartedAt + second * 1000);
    }
    assert.strictEqual(
      manager.outputActivityBuckets.get('bounded-agent').length,
      303,
      'ten minutes of output should retain only the bounded five-minute bucket window',
    );
    const shortRate = manager.calculateAgentUsageRate('bounded-agent', {
      now: boundedStartedAt + 600_000,
      windowMs: 60_000,
    });
    assert.strictEqual(shortRate.outputBytes, 61);
    assert.strictEqual(shortRate.eventCount, 61);
    const boundedRate = manager.calculateAgentUsageRate('bounded-agent', {
      now: boundedStartedAt + 600_000,
      windowMs,
    });
    assert.strictEqual(boundedRate.outputBytes, 301);
    assert.strictEqual(boundedRate.eventCount, 301);
    assert.strictEqual(
      manager.outputActivityBuckets.get('bounded-agent').length,
      301,
      'a short-window read must retain the full five-minute history for later readers',
    );
    const clampedRate = manager.calculateAgentUsageRate('bounded-agent', {
      now: boundedStartedAt + 600_000,
      windowMs: 10 * 60 * 1000,
    });
    assert.strictEqual(clampedRate.windowMs, windowMs);
    assert.strictEqual(clampedRate.outputBytes, 301);

    const disorderStartedAt = 4_000_000;
    clockNow = disorderStartedAt + 5000;
    manager.recordAgentOutputActivity('disorder-agent', 10, disorderStartedAt + 4000);
    manager.recordAgentOutputActivity('disorder-agent', 20, disorderStartedAt + 2500);
    manager.recordAgentOutputActivity('disorder-agent', 30, disorderStartedAt + 2900);
    manager.recordAgentOutputActivity('disorder-agent', 40, disorderStartedAt + 5000);
    const disorderBuckets = manager.outputActivityBuckets.get('disorder-agent');
    assert.deepStrictEqual(
      disorderBuckets.map(bucket => bucket.bucketStartedAt),
      [disorderStartedAt + 2000, disorderStartedAt + 4000, disorderStartedAt + 5000],
    );
    assert.strictEqual(disorderBuckets[0].bytes, 50);
    assert.strictEqual(disorderBuckets[0].eventCount, 2);

    const futureStartedAt = 5_000_000;
    clockNow = futureStartedAt;
    manager.recordAgentOutputActivity('future-agent', 10, futureStartedAt - 1000);
    manager.recordAgentOutputActivity('future-agent', 20, futureStartedAt + 60_000);
    manager.recordAgentOutputActivity('future-agent', 30, futureStartedAt);
    const futureBuckets = manager.outputActivityBuckets.get('future-agent');
    assert.strictEqual(futureBuckets.length, 3);
    assert(
      futureBuckets.at(-1).lastEventAt <= futureStartedAt + 1000,
      'an anomalous future timestamp must be clamped without evicting valid buckets',
    );
    const futureRate = manager.calculateAgentUsageRate('future-agent', {
      now: futureStartedAt,
      windowMs,
    });
    assert.strictEqual(futureRate.outputBytes, 60);
    assert.strictEqual(futureRate.eventCount, 3);

    const boundaryNow = 6_000_500;
    const boundaryCutoff = boundaryNow - windowMs;
    clockNow = boundaryNow;
    manager.recordAgentOutputActivity('boundary-agent', 10, boundaryCutoff - 400);
    manager.recordAgentOutputActivity('boundary-agent', 20, boundaryCutoff + 100);
    const boundaryRate = manager.calculateAgentUsageRate('boundary-agent', {
      now: boundaryNow,
      windowMs,
    });
    assert.strictEqual(boundaryRate.outputBytes, 30);
    assert.strictEqual(
      boundaryRate.eventCount,
      2,
      'a bucket crossing the cutoff should be included as the documented one-bucket overestimate',
    );

    manager.agents.set('cleanup-agent', { id: 'cleanup-agent', status: 'stopped' });
    manager.recordAgentOutputActivity('cleanup-agent', 10, futureStartedAt);
    manager.getAgentUsageRate('cleanup-agent', { now: futureStartedAt, windowMs });
    manager.forgetStoppedAgentRecord('cleanup-agent', { emitUpdate: false });
    assert.strictEqual(manager.outputActivityBuckets.has('cleanup-agent'), false);
    assert.strictEqual(manager.agentUsageRateCache.has('cleanup-agent'), false);

    console.log('✓ agent output usage rate uses bounded buckets and expires stale activity');
  } finally {
    Date.now = originalDateNow;
    clearInterval(manager.heartbeatInterval);
    manager.engineBridge.dispose();
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
