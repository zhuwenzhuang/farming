type SessionPreview = Record<string, unknown>;

interface SessionPreviewBroadcastPorts<Timer> {
  deliver(preview: SessionPreview): void;
  intervalMs: number;
  now(): number;
  setTimer(callback: () => void, delayMs: number): Timer;
  clearTimer(timer: Timer): void;
}

interface PendingPreviewBroadcast<Timer> {
  lastAt: number;
  timer: Timer | null;
  preview: SessionPreview | null;
}

function previewAgentId(preview: SessionPreview): string | null {
  const { agentId } = preview;
  return typeof agentId === 'string' && agentId.length > 0 ? agentId : null;
}

function createWebSocketSessionPreviewBroadcasts<Timer>(ports: SessionPreviewBroadcastPorts<Timer>) {
  const pendingPreviewBroadcasts = new Map<string, PendingPreviewBroadcast<Timer>>();

  const schedule = (preview: SessionPreview): void => {
    const agentId = previewAgentId(preview);
    if (!agentId) {
      ports.deliver(preview);
      return;
    }

    const now = ports.now();
    const entry = pendingPreviewBroadcasts.get(agentId) || {
      lastAt: 0,
      timer: null,
      preview: null,
    };
    entry.preview = preview;

    const elapsed = now - entry.lastAt;
    if (elapsed >= ports.intervalMs) {
      if (entry.timer) {
        ports.clearTimer(entry.timer);
        entry.timer = null;
      }
      entry.lastAt = now;
      const latest = entry.preview;
      entry.preview = null;
      pendingPreviewBroadcasts.set(agentId, entry);
      if (latest) ports.deliver(latest);
      return;
    }

    if (!entry.timer) {
      entry.timer = ports.setTimer(() => {
        entry.timer = null;
        entry.lastAt = ports.now();
        const latest = entry.preview;
        entry.preview = null;
        pendingPreviewBroadcasts.set(agentId, entry);
        if (latest) ports.deliver(latest);
      }, ports.intervalMs - elapsed);
    }

    pendingPreviewBroadcasts.set(agentId, entry);
  };

  return { schedule };
}

export {
  createWebSocketSessionPreviewBroadcasts,
  type SessionPreview,
  type SessionPreviewBroadcastPorts,
};
