import { useEffect, useState } from 'react'
import type { CodeCopy } from '@/components/code/copy'
import { usePageVisibility } from '@/hooks/usePageVisibility'
import { useBackendConnectionStatus } from '@/lib/backend-live-status'

const BACKEND_INITIAL_CONNECT_GRACE_MS = 3000
const BACKEND_HEARTBEAT_STALE_MS = 6000

type ConnectionState = 'connecting' | 'lost' | 'stale' | null

function classifyBackendConnection(
  connected: boolean,
  everConnected: boolean,
  lastMessageAt: number,
  now: number,
): ConnectionState {
  const elapsed = Math.max(0, now - lastMessageAt)
  if (!connected && everConnected) return 'lost'
  if (!connected && elapsed >= BACKEND_INITIAL_CONNECT_GRACE_MS) return 'connecting'
  if (connected && elapsed >= BACKEND_HEARTBEAT_STALE_MS) return 'stale'
  return null
}

export function BackendConnectionStatus({ copy }: { copy: CodeCopy }) {
  const connection = useBackendConnectionStatus()
  const pageVisible = usePageVisibility()
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!pageVisible) return undefined
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [pageVisible])

  const state = classifyBackendConnection(
    connection.connected,
    connection.everConnected,
    connection.lastMessageAt,
    now,
  )
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
