export const BACKEND_INITIAL_CONNECT_GRACE_MS: number
export const BACKEND_HEARTBEAT_FAILURE_MS: number
export const BACKEND_HEARTBEAT_STALE_MS: number
export const BACKEND_OBSERVER_LAG_RESET_MS: number

export type BackendConnectionState = 'connecting' | 'lost' | 'stale' | null
export interface PageVisibilitySnapshot {
  visible: boolean
  visibleSince: number
}
export interface BackendObservation {
  now: number
  continuousSince: number
}

export function advanceBackendObservation(
  current: BackendObservation,
  observedAt: number,
): BackendObservation

export function classifyBackendConnection(input: {
  connected: boolean
  everConnected: boolean
  lastMessageAt: number
  disconnectedAt: number | null
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
