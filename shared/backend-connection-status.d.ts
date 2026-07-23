export const BACKEND_INITIAL_CONNECT_GRACE_MS: number
export const BACKEND_HEARTBEAT_STALE_MS: number

export type BackendConnectionState = 'connecting' | 'lost' | 'stale' | null
export interface PageVisibilitySnapshot {
  visible: boolean
  visibleSince: number
}

export function classifyBackendConnection(input: {
  connected: boolean
  everConnected: boolean
  lastMessageAt: number
  visibleSince: number
  now: number
}): BackendConnectionState

export function reducePageVisibilitySnapshot(
  current: PageVisibilitySnapshot,
  event: {
    eventType: string
    documentVisible: boolean
    changedAt: number
  },
): PageVisibilitySnapshot
