import {
  sanitizeAgentUpdatePatch,
  type AgentUpdatePatch,
} from '../shared/browser-protocol.js';

interface WebSocketAgentChangeClient {
  readyState: number;
  send(data: string): void;
}

interface WebSocketAgentChangePorts<Client extends WebSocketAgentChangeClient> {
  clients(): Iterable<Client>;
  deferUntilSnapshot(
    client: Client,
    message: string,
    isRelevant: () => boolean,
  ): boolean;
  openState: number;
  scopeIncludesAgent(client: Client, agentId: string): boolean;
  setTimer(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  updateDelayMs: number;
}

type AgentScopedEvent = Record<string, unknown> & { agentId: string };

function isAgentScopedEvent(value: unknown): value is AgentScopedEvent {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && typeof (value as { agentId?: unknown }).agentId === 'string'
    && (value as { agentId: string }).agentId.length > 0;
}

function createWebSocketAgentChangeBroadcasts<Client extends WebSocketAgentChangeClient>(
  ports: WebSocketAgentChangePorts<Client>,
) {
  const pendingUpdates = new Map<string, {
    patch: AgentUpdatePatch;
    timer: ReturnType<typeof setTimeout>;
  }>();

  const deliver = (agentId: string, message: string) => {
    for (const client of ports.clients()) {
      if (client.readyState !== ports.openState || !ports.scopeIncludesAgent(client, agentId)) continue;
      const stillRelevant = () => ports.scopeIncludesAgent(client, agentId);
      if (!ports.deferUntilSnapshot(client, message, stillRelevant)) client.send(message);
    }
  };

  const scheduleAgentUpdate = (update: unknown) => {
    if (!isAgentScopedEvent(update)) return;
    const patch = sanitizeAgentUpdatePatch(update.patch);
    if (!patch) return;
    const existing = pendingUpdates.get(update.agentId);
    if (existing) {
      Object.assign(existing.patch, patch);
      return;
    }
    const entry = {
      patch,
      timer: ports.setTimer(() => {
        pendingUpdates.delete(update.agentId);
        deliver(update.agentId, JSON.stringify({
          type: 'agent-update',
          update: { agentId: update.agentId, patch: entry.patch },
        }));
      }, ports.updateDelayMs),
    };
    entry.timer.unref?.();
    pendingUpdates.set(update.agentId, entry);
  };

  const broadcastAgentRead = (read: unknown) => {
    if (!isAgentScopedEvent(read)) return;
    deliver(read.agentId, JSON.stringify({ type: 'agent-read', read }));
  };

  return { broadcastAgentRead, scheduleAgentUpdate };
}

export {
  createWebSocketAgentChangeBroadcasts,
  type WebSocketAgentChangeClient,
  type WebSocketAgentChangePorts,
};
