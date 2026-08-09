type AgentActivity = Record<string, unknown> & { agentId: string };

interface AgentActivityBroadcastTimer {
  unref?: () => void;
}

interface AgentActivityBroadcastPorts {
  deliver(activity: AgentActivity): void;
  delayMs: number;
  setTimer(callback: () => void, delayMs: number): AgentActivityBroadcastTimer;
}

interface PendingAgentActivity {
  activity: AgentActivity;
  timer: AgentActivityBroadcastTimer;
}

function isAgentActivity(value: unknown): value is AgentActivity {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && typeof (value as { agentId?: unknown }).agentId === 'string'
    && (value as { agentId: string }).agentId.length > 0;
}

function createWebSocketAgentActivityBroadcasts(ports: AgentActivityBroadcastPorts) {
  const pendingAgentActivityBroadcasts = new Map<string, PendingAgentActivity>();

  const schedule = (activity: unknown): void => {
    if (!isAgentActivity(activity)) return;
    const existing = pendingAgentActivityBroadcasts.get(activity.agentId);
    if (existing) {
      existing.activity = activity;
      return;
    }
    const entry: PendingAgentActivity = {
      activity,
      timer: ports.setTimer(() => {
        pendingAgentActivityBroadcasts.delete(activity.agentId);
        ports.deliver(entry.activity);
      }, ports.delayMs),
    };
    entry.timer.unref?.();
    pendingAgentActivityBroadcasts.set(activity.agentId, entry);
  };

  return { schedule };
}

export {
  createWebSocketAgentActivityBroadcasts,
  type AgentActivity,
  type AgentActivityBroadcastPorts,
  type AgentActivityBroadcastTimer,
};
