export const BACKEND_INITIAL_CONNECT_GRACE_MS: number

export type BackendConnectionState =
  | 'connecting'
  | 'lost'
  | 'business-recovering'
  | 'business-unavailable'
  | null
export interface PageVisibilitySnapshot {
  visible: boolean
  visibleSince: number
}
export function classifyBackendConnection(input: {
  connected: boolean
  lastMessageAt: number
  disconnectedAt: number | null
  visibleSince: number
  now: number
  businessStatus?: 'checking' | 'ready' | 'recovering' | 'failed' | 'stopping' | 'unresponsive'
}): BackendConnectionState

export function reducePageVisibilitySnapshot(
  current: PageVisibilitySnapshot,
  event: {
    eventType: string
    documentVisible: boolean
    changedAt: number
  },
): PageVisibilitySnapshot
