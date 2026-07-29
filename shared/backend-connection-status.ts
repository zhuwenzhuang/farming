export const BACKEND_INITIAL_CONNECT_GRACE_MS = 8_000

export type BackendBusinessStatus =
  | 'checking'
  | 'ready'
  | 'recovering'
  | 'failed'
  | 'stopping'
  | 'unresponsive'

export type BackendConnectionState =
  | 'connecting'
  | 'lost'
  | 'business-recovering'
  | 'business-unavailable'
  | null

export interface BackendConnectionSnapshot {
  connected: boolean
  lastMessageAt: number
  disconnectedAt?: number | null
  visibleSince: number
  now: number
  businessStatus?: BackendBusinessStatus
}

export interface PageVisibilitySnapshot {
  visible: boolean
  visibleSince: number
}

export interface PageVisibilityEvent {
  eventType: string
  documentVisible: boolean
  changedAt: number
}

export function classifyBackendConnection({
  connected,
  lastMessageAt,
  disconnectedAt,
  visibleSince,
  now,
  businessStatus,
}: BackendConnectionSnapshot): BackendConnectionState {
  // Application traffic is not a heartbeat. A connected socket can stay quiet
  // while the Agent is working; transport loss comes only from WebSocket close,
  // while business failure comes only from the explicit request/ack probe.
  if (connected) {
    if (businessStatus === 'recovering') return 'business-recovering'
    return businessStatus === 'failed'
      || businessStatus === 'stopping'
      || businessStatus === 'unresponsive'
      ? 'business-unavailable'
      : null
  }

  const disconnectObservedAt = typeof disconnectedAt === 'number' && Number.isFinite(disconnectedAt)
    ? disconnectedAt
    : lastMessageAt
  const disconnectedElapsed = Math.max(
    0,
    now - Math.max(disconnectObservedAt, visibleSince),
  )
  return disconnectedElapsed >= BACKEND_INITIAL_CONNECT_GRACE_MS
    ? 'lost'
    : 'connecting'
}

export function reducePageVisibilitySnapshot(
  current: PageVisibilitySnapshot,
  { eventType, documentVisible, changedAt }: PageVisibilityEvent,
): PageVisibilitySnapshot {
  const visible = eventType === 'pagehide' ? false : documentVisible
  if (visible === current.visible) {
    if (!visible || eventType !== 'pageshow') return current
    return { visible: true, visibleSince: changedAt }
  }
  return {
    visible,
    visibleSince: visible ? changedAt : current.visibleSince,
  }
}
