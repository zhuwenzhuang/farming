const assert = require('assert');
const { performance } = require('perf_hooks');
const { AgentManager } = require('../../backend/agent-manager.cjs');

const calculateAgentUsageRate = AgentManager.prototype.calculateAgentUsageRate;
const getAgentUsageRate = AgentManager.prototype.getAgentUsageRate;
const recordAgentOutputActivity = AgentManager.prototype.recordAgentOutputActivity;
const NOW = 10_000_000;
const WINDOW_MS = 5 * 60 * 1000;

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

function benchmark(eventCount: number) {
  const bucketCount = Math.min(300, eventCount);
  let calculationCount = 0;
  const manager = {
    outputActivityBuckets: new Map(),
    agentUsageRateCache: new Map(),
    calculateAgentUsageRate(agentId, options) {
      calculationCount += 1;
      return calculateAgentUsageRate.call(this, agentId, options);
    },
  };
  const aggregationStartedAt = performance.now();
  for (let index = 0; index < eventCount; index += 1) {
    const bucketIndex = Math.min(
      bucketCount - 1,
      Math.floor((index * bucketCount) / eventCount),
    );
    const eventAt = NOW - (bucketCount - 1 - bucketIndex) * 1000;
    recordAgentOutputActivity.call(manager, 'agent', 32, eventAt);
  }
  const aggregationMs = performance.now() - aggregationStartedAt;
  const buckets = manager.outputActivityBuckets.get('agent');
  assert.strictEqual(buckets.length, bucketCount);
  assert.deepStrictEqual(
    buckets.map(bucket => bucket.bucketStartedAt),
    [...buckets].sort((left, right) => left.bucketStartedAt - right.bucketStartedAt)
      .map(bucket => bucket.bucketStartedAt),
  );
  const iterations = 100_000;

  getAgentUsageRate.call(manager, 'agent', { now: NOW, windowMs: WINDOW_MS });

  const samples: number[] = [];
  for (let sample = 0; sample < 7; sample += 1) {
    const startedAt = performance.now();
    for (let index = 0; index < iterations; index += 1) {
      const result = getAgentUsageRate.call(manager, 'agent', { now: NOW + 1000, windowMs: WINDOW_MS });
      assert.strictEqual(result.eventCount, eventCount);
    }
    samples.push((performance.now() - startedAt) / iterations);
  }

  assert.strictEqual(calculationCount, 1, 'cached reads should not rescan output events');
  getAgentUsageRate.call(manager, 'agent', { now: NOW + 5000, windowMs: WINDOW_MS });
  assert.strictEqual(calculationCount, 2, 'the exact usage rate should refresh after five seconds');

  return {
    eventCount,
    bucketCount,
    aggregationMs: Math.round(aggregationMs * 1000) / 1000,
    iterations,
    exactCalculationCount: calculationCount,
    medianMicrosecondsPerCachedCall: Math.round(median(samples) * 1_000_000) / 1000,
  };
}

const results = [1_000, 10_000, 50_000].map(benchmark);
console.log(`performance-budget agent-usage-cache=${JSON.stringify({ results })}`);
