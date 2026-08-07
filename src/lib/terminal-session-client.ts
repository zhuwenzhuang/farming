import type {
  TerminalCheckpointResultMessage,
  TerminalSessionClientMessage,
} from '@/types/messages'
import type { SessionDataPayload } from '@/lib/terminal-bootstrap'

type TerminalSessionTransport = (message: TerminalSessionClientMessage) => boolean

interface PendingTerminalCheckpointRequest {
  agentId: string
  requestId: string
  signal: AbortSignal
  sent: boolean
  resolve: (payload: SessionDataPayload) => void
  reject: (error: Error) => void
  onAbort: () => void
}

declare global {
  interface Window {
    __FARMING_E2E__?: boolean
    __farmingTerminalCheckpointInterceptor?: (
      message: TerminalCheckpointResultMessage,
    ) => TerminalCheckpointResultMessage | null | Promise<TerminalCheckpointResultMessage | null>
  }
}

let transport: TerminalSessionTransport | null = null
let transportReady = false
let requestSequence = 0
const pendingCheckpointRequests = new Map<string, PendingTerminalCheckpointRequest>()

function terminalCheckpointRequestId() {
  requestSequence += 1
  const random = globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)
  return `terminal-checkpoint:${requestSequence}:${random}`
}

function abortError(signal: AbortSignal) {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('Terminal checkpoint request was cancelled', 'AbortError')
}

function deletePendingCheckpointRequest(request: PendingTerminalCheckpointRequest) {
  pendingCheckpointRequests.delete(request.requestId)
  request.signal.removeEventListener('abort', request.onAbort)
}

function sendPendingCheckpointRequest(request: PendingTerminalCheckpointRequest) {
  if (!transportReady || !transport || request.sent || request.signal.aborted) return false
  const sent = transport({
    type: 'terminal-checkpoint-request',
    requestId: request.requestId,
    agentId: request.agentId,
  })
  request.sent = sent
  if (!sent) transportReady = false
  return sent
}

function drainPendingCheckpointRequests() {
  if (!transportReady || !transport) return
  for (const request of pendingCheckpointRequests.values()) {
    if (!sendPendingCheckpointRequest(request)) return
  }
}

export function setTerminalSessionTransport(next: TerminalSessionTransport | null) {
  transport = next
  if (!next) {
    transportReady = false
    pendingCheckpointRequests.forEach(request => {
      request.sent = false
    })
  }
}

export function setTerminalSessionTransportReady(ready: boolean) {
  transportReady = ready && transport !== null
  if (!transportReady) {
    pendingCheckpointRequests.forEach(request => {
      request.sent = false
    })
    return
  }
  drainPendingCheckpointRequests()
}

export function sendTerminalSessionMessage(message: TerminalSessionClientMessage) {
  return transport?.(message) === true
}

export function requestTerminalSessionCheckpoint(agentId: string, signal: AbortSignal) {
  if (signal.aborted) return Promise.reject(abortError(signal))
  return new Promise<SessionDataPayload>((resolve, reject) => {
    const requestId = terminalCheckpointRequestId()
    const request: PendingTerminalCheckpointRequest = {
      agentId,
      requestId,
      signal,
      sent: false,
      resolve,
      reject,
      onAbort: () => {
        deletePendingCheckpointRequest(request)
        reject(abortError(signal))
      },
    }
    pendingCheckpointRequests.set(requestId, request)
    signal.addEventListener('abort', request.onAbort, { once: true })
    sendPendingCheckpointRequest(request)
  })
}

function settleTerminalSessionCheckpointResult(message: TerminalCheckpointResultMessage) {
  const request = pendingCheckpointRequests.get(message.requestId)
  if (!request || request.agentId !== message.agentId) return false
  deletePendingCheckpointRequest(request)
  if (!message.ok || !message.session) {
    request.reject(new Error(message.error || 'Terminal checkpoint is unavailable'))
    return true
  }
  request.resolve({ session: message.session })
  return true
}

export function settleTerminalSessionCheckpoint(message: TerminalCheckpointResultMessage) {
  const request = pendingCheckpointRequests.get(message.requestId)
  if (!request || request.agentId !== message.agentId) return false
  const interceptor = typeof window !== 'undefined' && window.__FARMING_E2E__
    ? window.__farmingTerminalCheckpointInterceptor
    : undefined
  if (!interceptor) return settleTerminalSessionCheckpointResult(message)

  void Promise.resolve(interceptor(message)).then(result => {
    if (result) settleTerminalSessionCheckpointResult(result)
  }).catch(error => {
    const pending = pendingCheckpointRequests.get(message.requestId)
    if (!pending) return
    deletePendingCheckpointRequest(pending)
    pending.reject(error instanceof Error ? error : new Error(String(error)))
  })
  return true
}
