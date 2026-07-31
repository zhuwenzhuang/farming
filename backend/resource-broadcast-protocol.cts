type ResourceBroadcastDomain = 'browser' | 'computer';
type ResourceBroadcastKind = 'deleted' | 'updated';

interface ResourceBroadcastEvent {
  collectionRevision: number;
  domain: ResourceBroadcastDomain;
  id: string;
  kind: ResourceBroadcastKind;
  message: Record<string, unknown>;
}

type ResourceClientDelivery = 'defer' | 'delta' | 'snapshot';

function resourceBroadcastKey(event: ResourceBroadcastEvent): string {
  return `${event.domain}:${event.id}`;
}

function coalesceResourceBroadcast(
  pending: Map<string, ResourceBroadcastEvent>,
  event: ResourceBroadcastEvent,
): void {
  const key = resourceBroadcastKey(event);
  const current = pending.get(key);
  if (
    current
    && (
      current.collectionRevision > event.collectionRevision
      || current.collectionRevision === event.collectionRevision
        && (current.kind === 'deleted' || event.kind !== 'deleted')
    )
  ) return;
  pending.set(key, event);
}

function drainResourceBroadcasts(
  pending: Map<string, ResourceBroadcastEvent>,
): ResourceBroadcastEvent[] {
  const events = [...pending.values()].sort((left, right) => (
    left.domain.localeCompare(right.domain)
    || left.collectionRevision - right.collectionRevision
    || left.id.localeCompare(right.id)
  ));
  pending.clear();
  return events;
}

function resourceClientDelivery(
  bufferedAmount: number,
  snapshotPending: boolean,
  maxBufferedAmount: number,
): ResourceClientDelivery {
  if (bufferedAmount > maxBufferedAmount) return 'defer';
  return snapshotPending ? 'snapshot' : 'delta';
}

export {
  coalesceResourceBroadcast,
  drainResourceBroadcasts,
  resourceClientDelivery,
};

export type {
  ResourceBroadcastEvent,
};
