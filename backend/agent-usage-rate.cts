/**
 * Bounded Agent output usage-rate accounting.
 *
 * Output events are retained in one-second buckets for at most the five-minute
 * reporting window. `projectAgentUsageRate` is a pure projection: it returns
 * the retained buckets and the rate value without mutating its input.
 */

interface TerminalOutputActivityBucket {
  bucketStartedAt: number;
  bytes: number;
  eventCount: number;
  firstEventAt: number;
  lastEventAt: number;
}

interface UsageRateOptions {
  now?: number;
  windowMs?: number;
}

interface AgentUsageRate {
  estimatedOutputTokens: number;
  estimatedTokensPerMinute: number;
  eventCount: number;
  outputBytes: number;
  sampledAt: number;
  source: string;
  windowMs: number;
}

interface AgentUsageRateProjection {
  retainedBuckets: TerminalOutputActivityBucket[];
  value: AgentUsageRate;
}

const AGENT_USAGE_RATE_WINDOW_MS = 5 * 60 * 1000;
const AGENT_USAGE_RATE_REFRESH_MS = 5 * 1000;
const TERMINAL_OUTPUT_ACTIVITY_BUCKET_MS = 1000;
const TERMINAL_OUTPUT_ACTIVITY_FUTURE_TOLERANCE_MS = 1000;

function terminalOutputActivityTotals(
  buckets: readonly TerminalOutputActivityBucket[],
  options: {
    cutoff: number;
    inclusiveCutoff?: boolean;
    maximumEventAt?: number;
  },
): { bytes: number; eventCount: number } {
  const maximumEventAt = options.maximumEventAt ?? Number.POSITIVE_INFINITY;
  const inclusiveCutoff = options.inclusiveCutoff !== false;
  let bytes = 0;
  let eventCount = 0;
  for (const bucket of buckets) {
    const beforeCutoff = inclusiveCutoff
      ? bucket.lastEventAt < options.cutoff
      : bucket.lastEventAt <= options.cutoff;
    if (beforeCutoff || bucket.firstEventAt > maximumEventAt) continue;
    bytes += Math.max(0, bucket.bytes || 0);
    eventCount += Math.max(0, bucket.eventCount || 0);
  }
  return { bytes, eventCount };
}

function recordTerminalOutputActivity(
  buckets: TerminalOutputActivityBucket[],
  timestamp: number,
  bytes: number,
): void {
  const observedAt = Date.now();
  const requestedEventAt = Number.isFinite(timestamp) ? Math.floor(timestamp) : observedAt;
  const eventAt = Math.min(
    requestedEventAt,
    observedAt + TERMINAL_OUTPUT_ACTIVITY_FUTURE_TOLERANCE_MS,
  );
  const outputBytes = Number.isFinite(bytes) ? Math.max(0, Math.floor(bytes)) : 0;
  const bucketStartedAt = Math.floor(eventAt / TERMINAL_OUTPUT_ACTIVITY_BUCKET_MS)
    * TERMINAL_OUTPUT_ACTIVITY_BUCKET_MS;
  const lastBucket = buckets.at(-1);
  let bucket = lastBucket?.bucketStartedAt === bucketStartedAt ? lastBucket : undefined;
  let insertionIndex = buckets.length;
  if (!bucket && lastBucket && bucketStartedAt < lastBucket.bucketStartedAt) {
    for (let index = buckets.length - 1; index >= 0; index -= 1) {
      const candidate = buckets[index];
      if (candidate.bucketStartedAt === bucketStartedAt) {
        bucket = candidate;
        break;
      }
      if (candidate.bucketStartedAt < bucketStartedAt) {
        insertionIndex = index + 1;
        break;
      }
      insertionIndex = index;
    }
  }
  if (!bucket) {
    bucket = {
      bucketStartedAt,
      bytes: 0,
      eventCount: 0,
      firstEventAt: eventAt,
      lastEventAt: eventAt,
    };
    if (!lastBucket || bucketStartedAt > lastBucket.bucketStartedAt) {
      buckets.push(bucket);
    } else {
      buckets.splice(insertionIndex, 0, bucket);
    }
  }
  bucket.bytes += outputBytes;
  bucket.eventCount += 1;
  bucket.firstEventAt = Math.min(bucket.firstEventAt, eventAt);
  bucket.lastEventAt = Math.max(bucket.lastEventAt, eventAt);

  const newestEventAt = Math.max(eventAt, buckets.at(-1)?.lastEventAt || eventAt);
  const retentionCutoff = newestEventAt
    - AGENT_USAGE_RATE_WINDOW_MS
    - TERMINAL_OUTPUT_ACTIVITY_BUCKET_MS
    - TERMINAL_OUTPUT_ACTIVITY_FUTURE_TOLERANCE_MS;
  while (buckets[0] && buckets[0].lastEventAt < retentionCutoff) buckets.shift();
}

function agentUsageRateWindowMs(value: unknown): number {
  const requested = Number(value);
  if (!Number.isFinite(requested) || requested <= 0) return AGENT_USAGE_RATE_WINDOW_MS;
  return Math.min(AGENT_USAGE_RATE_WINDOW_MS, Math.max(1, Math.floor(requested)));
}

function projectAgentUsageRate(
  buckets: readonly TerminalOutputActivityBucket[],
  options: UsageRateOptions = {},
): AgentUsageRateProjection {
  const now = options.now || Date.now();
  const windowMs = agentUsageRateWindowMs(options.windowMs);
  const retainedBuckets = buckets.filter(bucket => (
    bucket.lastEventAt >= now - AGENT_USAGE_RATE_WINDOW_MS
    && bucket.firstEventAt <= now + TERMINAL_OUTPUT_ACTIVITY_FUTURE_TOLERANCE_MS
  ));
  const activity = terminalOutputActivityTotals(retainedBuckets, {
    cutoff: now - windowMs,
    maximumEventAt: now + TERMINAL_OUTPUT_ACTIVITY_FUTURE_TOLERANCE_MS,
  });
  const estimatedOutputTokens = Math.ceil(activity.bytes / 4);
  const windowMinutes = Math.max(1, windowMs / 60_000);

  return {
    retainedBuckets,
    value: {
      windowMs,
      outputBytes: activity.bytes,
      estimatedOutputTokens,
      estimatedTokensPerMinute: Math.round((estimatedOutputTokens / windowMinutes) * 10) / 10,
      eventCount: activity.eventCount,
      sampledAt: now,
      source: 'terminal-output-estimate',
    },
  };
}

export {
  AGENT_USAGE_RATE_REFRESH_MS,
  AGENT_USAGE_RATE_WINDOW_MS,
  TERMINAL_OUTPUT_ACTIVITY_BUCKET_MS,
  TERMINAL_OUTPUT_ACTIVITY_FUTURE_TOLERANCE_MS,
  agentUsageRateWindowMs,
  projectAgentUsageRate,
  recordTerminalOutputActivity,
  terminalOutputActivityTotals,
};

export type {
  AgentUsageRate,
  AgentUsageRateProjection,
  TerminalOutputActivityBucket,
  UsageRateOptions,
};
