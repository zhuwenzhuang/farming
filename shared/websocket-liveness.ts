export const DEFAULT_WEBSOCKET_PING_INTERVAL_MS = 10_000

export interface WebSocketLivenessSocket {
  readyState: number
  farmingHeartbeatAlive?: boolean
  on(event: 'pong', handler: () => void): unknown
  ping(): void
  terminate(): void
}

export interface WebSocketServerLike<Socket extends WebSocketLivenessSocket> {
  clients: Iterable<Socket>
}

export type WebSocketLivenessTransition = 'ignored' | 'terminated' | 'pinged'

export function initializeWebSocketLiveness(socket: WebSocketLivenessSocket): void {
  socket.farmingHeartbeatAlive = true
  socket.on('pong', () => {
    socket.farmingHeartbeatAlive = true
  })
}

export function advanceWebSocketLiveness(
  socket: WebSocketLivenessSocket,
  openState: number,
): WebSocketLivenessTransition {
  if (socket.readyState !== openState) return 'ignored'
  if (socket.farmingHeartbeatAlive === false) {
    socket.terminate()
    return 'terminated'
  }
  socket.farmingHeartbeatAlive = false
  try {
    socket.ping()
  } catch {
    socket.terminate()
    return 'terminated'
  }
  return 'pinged'
}

export function startWebSocketLivenessMonitor<Socket extends WebSocketLivenessSocket>(
  webSocketServer: WebSocketServerLike<Socket>,
  {
    openState,
    intervalMs = DEFAULT_WEBSOCKET_PING_INTERVAL_MS,
  }: {
    openState: number
    intervalMs?: number
  },
): ReturnType<typeof setInterval> {
  const timer = setInterval(() => {
    for (const socket of webSocketServer.clients) {
      advanceWebSocketLiveness(socket, openState)
    }
  }, intervalMs)
  timer.unref?.()
  return timer
}
