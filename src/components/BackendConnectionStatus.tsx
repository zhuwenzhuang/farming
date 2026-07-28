import { useEffect, useState } from 'react'
import type { CodeCopy } from '@/components/code/copy'
import { isPageVisible, usePageVisibilitySnapshot } from '@/hooks/usePageVisibility'
import { useBackendConnectionStatus } from '@/lib/backend-live-status'
import {
  advanceBackendObservation,
  classifyBackendConnection,
} from '../../shared/backend-connection-status.js'

type ConnectionState = 'connecting' | 'lost' | 'stale' | null
type BackendObservation = {
  now: number
  continuousSince: number
}

export function BackendConnectionStatus({ copy }: { copy: CodeCopy }) {
  const connection = useBackendConnectionStatus()
  const pageVisibility = usePageVisibilitySnapshot()
  const [observation, setObservation] = useState<BackendObservation>(() => {
    const now = Date.now()
    return { now, continuousSince: now }
  })

  useEffect(() => {
    if (!pageVisibility.visible) return undefined
    const observedAt = Date.now()
    setObservation({ now: observedAt, continuousSince: observedAt })
    const timer = window.setInterval(() => {
      setObservation(current => advanceBackendObservation(current, Date.now()))
    }, 1000)
    return () => window.clearInterval(timer)
  }, [pageVisibility.visible])

  if (!pageVisibility.visible || !isPageVisible()) return null

  const state = classifyBackendConnection({
    connected: connection.connected,
    everConnected: connection.everConnected,
    lastMessageAt: connection.lastMessageAt,
    disconnectedAt: connection.disconnectedAt,
    visibleSince: Math.max(pageVisibility.visibleSince, observation.continuousSince),
    now: observation.now,
  }) as ConnectionState
  if (!state) return null

  const message = state === 'lost'
    ? copy.backendConnectionLost
    : state === 'stale'
      ? copy.backendHeartbeatLost
      : copy.backendConnecting

  return (
    <div
      className={`connection-status ${state}`}
      data-testid="connection-status"
      role="status"
      aria-live="polite"
    >
      <span className="connection-status-dot" aria-hidden="true" />
      <span>{message}</span>
    </div>
  )
}
