import {
  coalesceSessionStream,
  shouldBroadcastSessionStreamImmediately,
} from './session-stream-protocol.cjs';

type SessionStream = ReturnType<typeof coalesceSessionStream>;

interface SessionStreamTimer {
  unref?: () => void;
}

interface SessionStreamBroadcastPorts {
  deliver(stream: SessionStream): void;
  intervalMs: number;
  now(): number;
  setTimer(callback: () => void, delayMs: number): SessionStreamTimer;
}

function isAgentScopedSessionStream(value: unknown): value is Record<string, unknown> & { agentId: string } {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && typeof (value as { agentId?: unknown }).agentId === 'string'
    && (value as { agentId: string }).agentId.length > 0;
}

function sessionStreamKey(stream: Record<string, unknown> & { agentId: string }): string {
  return `${stream.agentId}\0${stream.sessionSource || ''}`;
}

function createWebSocketSessionStreamBroadcasts(ports: SessionStreamBroadcastPorts) {
  const pendingStreams = new Map<string, SessionStream>();
  let broadcastTimer: SessionStreamTimer | null = null;
  let lastBroadcastAt = 0;

  const flush = (): void => {
    broadcastTimer = null;
    const streams = Array.from(pendingStreams.values());
    pendingStreams.clear();
    if (streams.length > 0) lastBroadcastAt = ports.now();
    streams.forEach(ports.deliver);
  };

  const schedule = (stream: unknown): void => {
    if (!isAgentScopedSessionStream(stream)) return;
    const now = ports.now();
    if (shouldBroadcastSessionStreamImmediately({
      pendingCount: pendingStreams.size,
      lastBroadcastAt,
      now,
      intervalMs: ports.intervalMs,
    })) {
      lastBroadcastAt = now;
      ports.deliver(coalesceSessionStream(null, stream));
      return;
    }

    const key = sessionStreamKey(stream);
    pendingStreams.set(key, coalesceSessionStream(pendingStreams.get(key), stream));
    if (!broadcastTimer) {
      broadcastTimer = ports.setTimer(flush, ports.intervalMs);
      broadcastTimer.unref?.();
    }
  };

  return { schedule };
}

export {
  createWebSocketSessionStreamBroadcasts,
  type SessionStream,
  type SessionStreamBroadcastPorts,
  type SessionStreamTimer,
};
