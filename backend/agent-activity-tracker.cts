const ACTIVITY_UPDATE_INTERVAL_MS = 1_000;
const ACTIVITY_HOT_SEC = 30 * 60;
const ACTIVITY_WARM_SEC = 3 * 60 * 60;
const ACTIVITY_COOL_SEC = 12 * 60 * 60;

interface AgentActivityTrackerOptions {
  publish: (agentId: string, activityAt: number) => void;
}

function agentActivityLevel(
  lastActivity: number,
  now: number,
): 'hot' | 'warm' | 'cool' | 'cold' {
  const secondsSinceActivity = (now - lastActivity) / 1000;
  if (secondsSinceActivity < ACTIVITY_HOT_SEC) return 'hot';
  if (secondsSinceActivity < ACTIVITY_WARM_SEC) return 'warm';
  if (secondsSinceActivity < ACTIVITY_COOL_SEC) return 'cool';
  return 'cold';
}

/** Owns Agent activity timestamps and throttled activity publication. */
class AgentActivityTracker {
  readonly #activity = new Map<string, number>();
  readonly #lastPublished = new Map<string, number>();
  readonly #publish: AgentActivityTrackerOptions['publish'];

  constructor({ publish }: AgentActivityTrackerOptions) {
    this.#publish = publish;
  }

  record(agentId: string, activityAt: number = Date.now()): number {
    const timestamp = Number.isFinite(activityAt) ? activityAt : Date.now();
    this.#activity.set(agentId, timestamp);
    return timestamp;
  }

  publish(agentId: string, activityAt: number): boolean {
    const timestamp = this.record(agentId, activityAt);
    const lastPublishedAt = this.#lastPublished.get(agentId) || 0;
    if (timestamp - lastPublishedAt < ACTIVITY_UPDATE_INTERVAL_MS) return false;
    this.#lastPublished.set(agentId, timestamp);
    this.#publish(agentId, timestamp);
    return true;
  }

  get(agentId: string, fallback: number): number {
    return this.#activity.get(agentId) || fallback;
  }

  forget(agentId: string): void {
    this.#activity.delete(agentId);
    this.#lastPublished.delete(agentId);
  }

  dispose(): void {
    this.#activity.clear();
    this.#lastPublished.clear();
  }
}

export {
  ACTIVITY_COOL_SEC,
  ACTIVITY_HOT_SEC,
  ACTIVITY_UPDATE_INTERVAL_MS,
  ACTIVITY_WARM_SEC,
  AgentActivityTracker,
  agentActivityLevel,
  type AgentActivityTrackerOptions,
};
