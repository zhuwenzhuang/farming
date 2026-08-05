import { randomUUID } from 'node:crypto'
import { WebSocket, type RawData } from 'ws'
import {
  MIN_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  protocolCompatible,
  validateServerMessage,
} from '../shared/browser-protocol.js'
import { bearerCredential, joinUpstreamUrl } from './upstream.js'

const DEFAULT_WEBSOCKET_READINESS_TIMEOUT_MS = 5_000

export class DesktopBackendReadinessCancelledError extends Error {
  readonly code = 'FARMING_DESKTOP_BACKEND_READINESS_CANCELLED'
}

export class DesktopBackendReadinessFatalError extends Error {
  readonly code = 'FARMING_DESKTOP_BACKEND_READINESS_FATAL'
}

interface DesktopBackendWebSocketProbeOptions {
  baseUrl: string
  token: string
  signal?: AbortSignal
  timeoutMs?: number
}

function readinessCancelled() {
  return new DesktopBackendReadinessCancelledError('Farming backend readiness check was cancelled.')
}

function fatalReadinessError(message: string) {
  return new DesktopBackendReadinessFatalError(message)
}

function webSocketUrl(baseUrl: string) {
  const url = joinUpstreamUrl(baseUrl, '/ws')
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url
}

export function probeDesktopBackendWebSocket(options: DesktopBackendWebSocketProbeOptions) {
  if (options.signal?.aborted) return Promise.reject(readinessCancelled())
  const timeoutMs = options.timeoutMs ?? DEFAULT_WEBSOCKET_READINESS_TIMEOUT_MS
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return Promise.reject(new Error('Farming backend WebSocket readiness timeout is invalid.'))
  }

  return new Promise<void>((resolve, reject) => {
    const requestId = `desktop-readiness-${randomUUID()}`
    const socket = new WebSocket(webSocketUrl(options.baseUrl), {
      headers: options.token
        ? { authorization: `Bearer ${bearerCredential(options.token)}` }
        : undefined,
    })
    let sawHello = false
    let sawState = false
    let sawBusinessHealth = false
    let settling = false

    const completeIfReady = () => {
      if (sawHello && sawState && sawBusinessHealth) settle()
    }
    const completeAfterSocketClose = (error?: Error) => {
      let completed = false
      const complete = () => {
        if (completed) return
        completed = true
        if (error) reject(error)
        else resolve()
      }
      socket.removeAllListeners()
      socket.on('error', () => {})
      if (socket.readyState === WebSocket.CLOSED) {
        complete()
        return
      }
      socket.once('close', complete)
      socket.terminate()
    }
    const abort = () => settle(readinessCancelled())
    const timeout = setTimeout(() => {
      const missing = [
        !sawHello && 'protocol hello',
        !sawState && 'state',
        !sawBusinessHealth && 'business health',
      ].filter(Boolean).join(', ')
      settle(new Error(
        `Farming backend WebSocket readiness timed out after ${timeoutMs}ms${missing ? `; missing ${missing}` : ''}.`,
      ))
    }, timeoutMs)
    const settle = (error?: Error) => {
      if (settling) return
      settling = true
      clearTimeout(timeout)
      options.signal?.removeEventListener('abort', abort)
      completeAfterSocketClose(error)
    }

    options.signal?.addEventListener('abort', abort, { once: true })
    if (options.signal?.aborted) {
      abort()
      return
    }

    socket.once('open', () => {
      socket.send(JSON.stringify({ type: 'protocol-hello', protocolVersion: PROTOCOL_VERSION }))
      socket.send(JSON.stringify({ type: 'business-health-probe', requestId }))
    })
    socket.on('message', (data: RawData, isBinary: boolean) => {
      if (settling) return
      try {
        if (isBinary) throw new Error('binary frames are not supported')
        const parsed: unknown = JSON.parse(data.toString())
        const validation = validateServerMessage(parsed)
        if (!validation.ok) throw new Error(validation.error)
        const message = validation.value
        switch (message.type) {
          case 'protocol-hello':
            if (
              !protocolCompatible(message.protocolVersion)
              || message.minProtocolVersion > PROTOCOL_VERSION
              || message.minProtocolVersion > message.protocolVersion
              || message.protocolVersion < MIN_PROTOCOL_VERSION
            ) {
              settle(fatalReadinessError(
                `Farming backend protocol version ${message.protocolVersion} is incompatible with Desktop protocol ${PROTOCOL_VERSION}. Update the older of Farming Desktop or the Farming backend.`,
              ))
              return
            }
            sawHello = true
            break
          case 'state':
            sawState = true
            break
          case 'business-health-result':
            if (message.requestId !== requestId) break
            if (!protocolCompatible(message.protocolVersion)) {
              settle(fatalReadinessError(
                `Farming backend business health reported incompatible protocol version ${message.protocolVersion}.`,
              ))
              return
            }
            if (message.status === 'recovering') {
              settle(new Error(
                `Farming backend is ${message.status}; wait for it to become ready, then reconnect.`,
              ))
              return
            }
            if (message.status !== 'ready') {
              settle(fatalReadinessError(
                `Farming backend reported terminal business status ${message.status}.`,
              ))
              return
            }
            sawBusinessHealth = true
            break
          case 'protocol-error':
          case 'error':
            settle(fatalReadinessError(`Farming backend rejected its readiness check: ${message.message}`))
            return
        }
        completeIfReady()
      } catch (error) {
        settle(fatalReadinessError(
          `Farming backend returned an invalid WebSocket readiness message: ${error instanceof Error ? error.message : String(error)}`,
        ))
      }
    })
    socket.once('error', error => {
      settle(new Error(`Farming backend WebSocket readiness probe failed: ${error.message}`))
    })
    socket.once('close', (code, reason) => {
      if (settling) return
      const detail = reason.toString().trim()
      settle(code === 4001 || code === 4002 ? fatalReadinessError(
        code === 4001
          ? `Farming backend rejected WebSocket authentication${detail ? `: ${detail}` : '.'}`
          : `Farming backend closed the readiness probe for an incompatible protocol${detail ? `: ${detail}` : '.'}`,
      ) : new Error(
        `Farming backend WebSocket closed before readiness completed (code ${code})${detail ? `: ${detail}` : '.'}`,
      ))
    })
  })
}
