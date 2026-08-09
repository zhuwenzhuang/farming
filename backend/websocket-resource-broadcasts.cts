import {
  coalesceResourceBroadcast,
  drainResourceBroadcasts,
  resourceClientDelivery,
  type ResourceBroadcastEvent,
} from './resource-broadcast-protocol.cjs';

type ResourceBroadcastDomain = 'browser' | 'computer';

interface WebSocketResourceBroadcastClient {
  bufferedAmount: number;
  protocolVersion?: number;
  readyState: number;
  resourceSnapshotPending?: boolean;
  send(data: string): void;
}

interface WebSocketResourceBroadcastPorts<Client extends WebSocketResourceBroadcastClient> {
  clients(): Iterable<Client>;
  intervalMs: number;
  maxBufferedAmount: number;
  openState: number;
  protocolVersion: number;
  sendResourceSnapshots(client: Client): void;
  setTimer(callback: () => void, delay: number): unknown;
}

interface WebSocketResourceBroadcastController<Client extends WebSocketResourceBroadcastClient> {
  recoverSnapshotIfReady(client: Client): void;
  scheduleDeletion(domain: ResourceBroadcastDomain, deletion: unknown): void;
  scheduleUpdate(domain: ResourceBroadcastDomain, resource: unknown): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function createWebSocketResourceBroadcastController<Client extends WebSocketResourceBroadcastClient>(
  ports: WebSocketResourceBroadcastPorts<Client>,
): WebSocketResourceBroadcastController<Client> {
  const pendingBroadcasts = new Map<string, ResourceBroadcastEvent>();
  let broadcastTimer: unknown | null = null;

  function isReady(client: Client): boolean {
    return client.readyState === ports.openState && client.protocolVersion === ports.protocolVersion;
  }

  function broadcast(event: ResourceBroadcastEvent): void {
    const message = JSON.stringify(event.message);
    for (const client of ports.clients()) {
      if (!isReady(client)) continue;
      const delivery = resourceClientDelivery(
        client.bufferedAmount,
        client.resourceSnapshotPending === true,
        ports.maxBufferedAmount,
      );
      if (delivery === 'defer') {
        client.resourceSnapshotPending = true;
        continue;
      }
      if (delivery === 'snapshot') {
        ports.sendResourceSnapshots(client);
        continue;
      }
      client.send(message);
    }
  }

  function flush(): void {
    broadcastTimer = null;
    drainResourceBroadcasts(pendingBroadcasts).forEach(broadcast);
  }

  function schedule(event: ResourceBroadcastEvent): void {
    coalesceResourceBroadcast(pendingBroadcasts, event);
    if (broadcastTimer) return;
    broadcastTimer = ports.setTimer(flush, ports.intervalMs);
  }

  function scheduleUpdate(domain: ResourceBroadcastDomain, resource: unknown): void {
    if (!isRecord(resource)) return;
    const id = typeof resource.id === 'string' ? resource.id : '';
    const collectionRevision = Number(resource.collectionRevision);
    const revision = Number(resource.revision);
    if (!id || !Number.isInteger(collectionRevision) || collectionRevision < 0 || !Number.isInteger(revision) || revision < 0) return;
    schedule({
      domain,
      id,
      collectionRevision,
      kind: 'updated',
      message: { type: `${domain}-resource-updated`, resource },
    });
  }

  function scheduleDeletion(domain: ResourceBroadcastDomain, deletion: unknown): void {
    if (!isRecord(deletion)) return;
    const id = typeof deletion.id === 'string' ? deletion.id : '';
    const collectionRevision = Number(deletion.collectionRevision);
    if (!id || !Number.isInteger(collectionRevision) || collectionRevision < 0) return;
    schedule({
      domain,
      id,
      collectionRevision,
      kind: 'deleted',
      message: { type: `${domain}-resource-deleted`, deletion },
    });
  }

  function recoverSnapshotIfReady(client: Client): void {
    if (!isReady(client)) return;
    const delivery = resourceClientDelivery(
      client.bufferedAmount,
      client.resourceSnapshotPending === true,
      ports.maxBufferedAmount,
    );
    if (delivery === 'snapshot') ports.sendResourceSnapshots(client);
  }

  return { recoverSnapshotIfReady, scheduleDeletion, scheduleUpdate };
}

export {
  createWebSocketResourceBroadcastController,
  type WebSocketResourceBroadcastClient,
  type WebSocketResourceBroadcastController,
  type WebSocketResourceBroadcastPorts,
};
