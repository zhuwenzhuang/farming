/**
 * Agent-state broadcast coalescing scheduler.
 *
 * State model
 * - Authoritative owner: this module exclusively holds the pending Agent-state
 *   mutation (pending agent ids, accumulated metadata patch, mainAgentId and
 *   taskHistory intent), the single coalesce timer, and the last-delivery
 *   timestamp. The host owns only the authoritative projection, metadata read,
 *   and client sink it injects here.
 * - Triggers: queueChange and queueMetadata accumulate intent and schedule;
 *   flush is the single delivery point, used by both the timer and the host.
 * - Guards: a schedule within intervalMs of the last delivery is deferred to
 *   one trailing timer; further schedules keep the armed timer rather than
 *   replacing it. flush cancels the armed timer.
 * - Effects: flush resolves each pending agent id through the authoritative
 *   projection into an upsert or a removal, drains all pending intent, then
 *   calls deliver exactly once.
 * - Serial delivery: intent is drained before deliver runs, so a reentrant
 *   queue from inside deliver starts a fresh pending generation with its own
 *   trailing timer instead of mutating the payload already in flight.
 * - Terminal failure: deliver throws to its caller (host call site or timer
 *   callback). The timer is already cancelled and intent already drained, so
 *   the failure is not retried and cannot be replayed.
 * - Liveness: every queue either delivers immediately or arms exactly one
 *   bounded timer, including after a failed delivery.
 * - Recovery: the host connection-recovery path calls flush with its own
 *   context; the scheduler treats it as an ordinary delivery point that also
 *   drains and resets the coalescing window.
 */

interface AgentStateBroadcastSchedulerChange {
  agentIds?: string[];
  mainAgentIdChanged?: boolean;
  removedAgentIds?: string[];
  taskHistoryChanged?: boolean;
}

interface AgentStateBroadcastSchedulerMutation<Agent> {
  removedAgentIds: string[];
  state?: Record<string, unknown>;
  upserts: Agent[];
}

interface AgentStateBroadcastSchedulerPorts<Agent, Context, Timer> {
  clearTimer(timer: Timer): void;
  deliver(mutation: AgentStateBroadcastSchedulerMutation<Agent>, context: Context | null): void;
  intervalMs: number;
  now(): number;
  projectAgent(agentId: string, now: number): Agent | null;
  setTimer(callback: () => void, delayMs: number): Timer;
  stateMetadata(): { mainAgentId: unknown; taskHistory: unknown };
}

function createWebSocketAgentStateBroadcastScheduler<Agent, Context, Timer>(
  ports: AgentStateBroadcastSchedulerPorts<Agent, Context, Timer>,
) {
  const pendingAgentIds = new Set<string>();
  let pendingMetadata: Record<string, unknown> = {};
  let pendingMainAgentId = false;
  let pendingTaskHistory = false;
  let timer: Timer | null = null;
  let lastDeliveredAt = 0;

  const drainPending = (now: number): AgentStateBroadcastSchedulerMutation<Agent> => {
    const upserts: Agent[] = [];
    const removedAgentIds: string[] = [];
    for (const agentId of pendingAgentIds) {
      const agent = ports.projectAgent(agentId, now);
      if (agent) upserts.push(agent);
      else removedAgentIds.push(agentId);
    }
    const metadata = ports.stateMetadata();
    const state = {
      ...pendingMetadata,
      ...(pendingMainAgentId ? { mainAgentId: metadata.mainAgentId } : {}),
      ...(pendingTaskHistory ? { taskHistory: metadata.taskHistory } : {}),
    };
    pendingAgentIds.clear();
    pendingMainAgentId = false;
    pendingTaskHistory = false;
    pendingMetadata = {};
    return {
      upserts,
      removedAgentIds,
      ...(Object.keys(state).length > 0 ? { state } : {}),
    };
  };

  const flush = (context: Context | null = null): void => {
    const now = ports.now();
    lastDeliveredAt = now;
    if (timer !== null) ports.clearTimer(timer);
    timer = null;
    ports.deliver(drainPending(now), context);
  };

  const schedule = (): void => {
    const elapsed = ports.now() - lastDeliveredAt;
    if (elapsed >= ports.intervalMs) {
      flush();
      return;
    }
    if (timer !== null) return;
    timer = ports.setTimer(() => {
      flush();
    }, ports.intervalMs - elapsed);
  };

  const queueChange = (change: AgentStateBroadcastSchedulerChange): void => {
    change.agentIds?.forEach(agentId => pendingAgentIds.add(agentId));
    change.removedAgentIds?.forEach(agentId => pendingAgentIds.add(agentId));
    if (change.mainAgentIdChanged === true) pendingMainAgentId = true;
    if (change.taskHistoryChanged === true) pendingTaskHistory = true;
    schedule();
  };

  const queueMetadata = (state: Record<string, unknown>): void => {
    Object.assign(pendingMetadata, state);
    schedule();
  };

  return { flush, queueChange, queueMetadata };
}

export {
  createWebSocketAgentStateBroadcastScheduler,
  type AgentStateBroadcastSchedulerChange,
  type AgentStateBroadcastSchedulerMutation,
  type AgentStateBroadcastSchedulerPorts,
};
