/**
 * Owner of Agent output usage-rate accounting state.
 *
 * This tracker holds the only retained one-second output buckets and the only
 * bounded rate cache. Buckets never leave the tracker: AgentManager records
 * output bytes and reads rate projections or activity totals through this
 * narrow port, so Agent removal has exactly one cleanup path.
 * Every transition is synchronous: recording projects bytes into buckets,
 * reading either returns a cached value for the exact window or recomputes and
 * evicts an empty projection, and forgetting is idempotent. The tracker owns no
 * timers, persistence, or Agent identity beyond the ids it is given.
 */

import {
  AGENT_USAGE_RATE_REFRESH_MS,
  agentUsageRateWindowMs,
  projectAgentUsageRate,
  recordTerminalOutputActivity,
  terminalOutputActivityTotals,
} from './agent-usage-rate.cjs';
import type {
  AgentUsageRate,
  TerminalOutputActivityBucket,
  UsageRateOptions,
} from './agent-usage-rate.cjs';
import type { AgentId } from './agent-manager-record-types.js';

interface AgentUsageRateCacheEntry {
  sampledAt: number;
  value: AgentUsageRate;
  windowMs: number;
}

const NO_RETAINED_BUCKETS: readonly TerminalOutputActivityBucket[] = [];

class AgentUsageRateTracker {
  private readonly activityBuckets = new Map<AgentId, TerminalOutputActivityBucket[]>();
  private readonly rateCache = new Map<AgentId, AgentUsageRateCacheEntry>();

  record(agentId: AgentId, bytes: number, timestamp = Date.now()): void {
    const buckets = this.activityBuckets.get(agentId) || [];
    recordTerminalOutputActivity(buckets, timestamp, bytes);
    this.activityBuckets.set(agentId, buckets);
  }

  getRate(agentId: AgentId, options: UsageRateOptions = {}): AgentUsageRate {
    const now = options.now || Date.now();
    const windowMs = agentUsageRateWindowMs(options.windowMs);
    const cached = this.rateCache.get(agentId);
    if (
      cached
      && cached.windowMs === windowMs
      && now >= cached.sampledAt
      && now - cached.sampledAt < AGENT_USAGE_RATE_REFRESH_MS
    ) {
      return cached.value;
    }

    const value = this.calculateRate(agentId, { now, windowMs });
    this.rateCache.set(agentId, { windowMs, sampledAt: now, value });
    return value;
  }

  calculateRate(agentId: AgentId, options: UsageRateOptions = {}): AgentUsageRate {
    const now = options.now || Date.now();
    const windowMs = agentUsageRateWindowMs(options.windowMs);
    const projection = projectAgentUsageRate(
      this.activityBuckets.get(agentId) || NO_RETAINED_BUCKETS,
      { now, windowMs },
    );
    if (projection.retainedBuckets.length > 0) {
      this.activityBuckets.set(agentId, projection.retainedBuckets);
    } else {
      this.activityBuckets.delete(agentId);
    }
    return projection.value;
  }

  getActivityTotals(
    agentId: AgentId,
    options: { cutoff: number; inclusiveCutoff?: boolean },
  ): { bytes: number; eventCount: number } {
    return terminalOutputActivityTotals(
      this.activityBuckets.get(agentId) || NO_RETAINED_BUCKETS,
      options,
    );
  }

  forget(agentId: AgentId): void {
    this.activityBuckets.delete(agentId);
    this.rateCache.delete(agentId);
  }
}

export { AgentUsageRateTracker };
