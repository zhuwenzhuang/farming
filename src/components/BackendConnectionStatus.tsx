import { useEffect, useState } from 'react'
import type { CodeCopy } from '@/components/code/copy'
import { isPageVisible, usePageVisibilitySnapshot } from '@/hooks/usePageVisibility'
import { useBackendConnectionStatus } from '@/lib/backend-live-status'
import { classifyBackendConnection } from '../../shared/backend-connection-status.js'

type ConnectionState =
  | 'connecting'
  | 'lost'
  | 'business-recovering'
  | 'business-unavailable'
  | null

export function BackendConnectionStatus({ copy }: { copy: CodeCopy }) {
  const connection = useBackendConnectionStatus()
  const pageVisibility = usePageVisibilitySnapshot()
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!pageVisibility.visible || connection.connected) return undefined
    setNow(Date.now())
    const timer = window.setInterval(() => {
      setNow(Date.now())
    }, 1000)
    return () => window.clearInterval(timer)
  }, [connection.connected, connection.disconnectedAt, pageVisibility.visible])

  if (!pageVisibility.visible || !isPageVisible()) return null

  const state = classifyBackendConnection({
    connected: connection.connected,
    lastMessageAt: connection.lastMessageAt,
    disconnectedAt: connection.disconnectedAt,
    visibleSince: pageVisibility.visibleSince,
    now,
    businessStatus: connection.businessStatus,
  }) as ConnectionState
  if (!state) return null

  const message = state === 'business-recovering'
    ? copy.backendBusinessRecovering
    : state === 'business-unavailable'
      ? copy.backendBusinessUnavailable
      : state === 'lost'
        ? copy.backendConnectionLost
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
