import { useEffect, useState } from 'react'
import type { CodeCopy } from '@/components/code/copy'
import { isPageVisible, usePageVisibilitySnapshot } from '@/hooks/usePageVisibility'
import { useBackendConnectionStatus } from '@/lib/backend-live-status'
import { classifyBackendConnection } from '../../shared/backend-connection-status.js'

type ConnectionState = 'connecting' | 'lost' | 'stale' | null

export function BackendConnectionStatus({ copy }: { copy: CodeCopy }) {
  const connection = useBackendConnectionStatus()
  const pageVisibility = usePageVisibilitySnapshot()
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!pageVisibility.visible) return undefined
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [pageVisibility.visible])

  if (!pageVisibility.visible || !isPageVisible()) return null

  const state = classifyBackendConnection({
    connected: connection.connected,
    everConnected: connection.everConnected,
    lastMessageAt: connection.lastMessageAt,
    visibleSince: pageVisibility.visibleSince,
    now,
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
