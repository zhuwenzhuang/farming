const assert = require('assert');
const { performance } = require('perf_hooks');
const { AgentUsageRateTracker } = require('../../backend/agent-usage-rate-tracker.cjs');

const NOW = 10_000_000;
const WINDOW_MS = 5 * 60 * 1000;

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

function benchmark(eventCount: number) {
  const bucketCount = Math.min(300, eventCount);
  let calculationCount = 0;
  const tracker = new AgentUsageRateTracker();
  const calculateRate = tracker.calculateRate.bind(tracker);
  tracker.calculateRate = (agentId, options) => {
    calculationCount += 1;
    return calculateRate(agentId, options);
  };
  const aggregationStartedAt = performance.now();
  for (let index = 0; index < eventCount; index += 1) {
    const bucketIndex = Math.min(
      bucketCount - 1,
      Math.floor((index * bucketCount) / eventCount),
    );
    const eventAt = NOW - (bucketCount - 1 - bucketIndex) * 1000;
    tracker.record('agent', 32, eventAt);
  }
  const aggregationMs = performance.now() - aggregationStartedAt;
  const iterations = 100_000;

  tracker.getRate('agent', { now: NOW, windowMs: WINDOW_MS });

  const samples: number[] = [];
  for (let sample = 0; sample < 7; sample += 1) {
    const startedAt = performance.now();
    for (let index = 0; index < iterations; index += 1) {
      const result = tracker.getRate('agent', { now: NOW + 1000, windowMs: WINDOW_MS });
      assert.strictEqual(result.eventCount, eventCount);
    }
    samples.push((performance.now() - startedAt) / iterations);
  }

  assert.strictEqual(calculationCount, 1, 'cached reads should not rescan output events');
  tracker.getRate('agent', { now: NOW + 5000, windowMs: WINDOW_MS });
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
