import type {
  LanguageServerRequestMessage,
  LanguageServerRequestPayload,
  LanguageServerResultMessage,
  WorkspaceProtocolError,
  WorkspaceCancelMessage,
  WorkspaceRequest,
  WorkspaceRequestMessage,
  WorkspaceResultMessage,
} from '../../shared/browser-protocol'
import { MAX_INLINE_WORKSPACE_MESSAGE_BYTES } from '../../shared/browser-protocol'

type WorkspaceTransportMessage = WorkspaceRequestMessage | WorkspaceCancelMessage | LanguageServerRequestMessage
type WorkspaceTransport = (message: WorkspaceTransportMessage) => boolean
type RequestDomain = 'workspace' | 'language-server'

interface PendingRequest {
  domain: RequestDomain
  requestId: string
  message: WorkspaceTransportMessage
  mutation: boolean
  sent: boolean
  signal?: AbortSignal
  timeout?: ReturnType<typeof setTimeout>
  onAbort?: () => void
  resolve(value: unknown): void
  reject(error: Error): void
}

export class WorkspaceTransportError extends Error {
  readonly code: string
  readonly status: number
  readonly details: unknown
  readonly uncertain: boolean

  constructor(error: WorkspaceProtocolError) {
    super(error.message)
    this.name = 'WorkspaceTransportError'
    this.code = error.code
    this.status = error.status ?? 500
    this.details = error.details
    this.uncertain = error.uncertain === true
  }
}

let transport: WorkspaceTransport | null = null
let transportReady = false
let requestSequence = 0
let inlineMessageLimit = MAX_INLINE_WORKSPACE_MESSAGE_BYTES
const pendingRequests = new Map<string, PendingRequest>()

function requestId(domain: RequestDomain): string {
  requestSequence += 1
  const random = globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)
  return `${domain}:${requestSequence}:${random}`
}

function requestError(code: string, message: string, uncertain = false): WorkspaceTransportError {
  return new WorkspaceTransportError({ code, message, uncertain })
}

function abortError(signal?: AbortSignal, uncertain = false): Error {
  if (uncertain) return requestError('CANCELLED', 'Workspace mutation was cancelled with an uncertain outcome', true)
  return signal?.reason instanceof Error
    ? signal.reason
    : new DOMException('Workspace request was cancelled', 'AbortError')
}

function deletePending(request: PendingRequest): void {
  pendingRequests.delete(request.requestId)
  if (request.timeout) clearTimeout(request.timeout)
  if (request.signal && request.onAbort) request.signal.removeEventListener('abort', request.onAbort)
}

function sendPending(request: PendingRequest): boolean {
  if (!transportReady || !transport || request.sent || request.signal?.aborted) return false
  const sent = transport(request.message)
  request.sent = sent
  if (!sent) transportReady = false
  return sent
}

function cancelPending(request: PendingRequest): void {
  const uncertain = request.mutation && request.sent
  deletePending(request)
  if (request.sent && transportReady && transport) {
    transport({ type: 'workspace-cancel', requestId: request.requestId })
  }
  request.reject(abortError(request.signal, uncertain))
}

function createRequest<T>(
  domain: RequestDomain,
  message: WorkspaceTransportMessage,
  options: { mutation?: boolean; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<T> {
  if (options.signal?.aborted) return Promise.reject(abortError(options.signal))
  return new Promise<T>((resolve, reject) => {
    const id = 'requestId' in message ? String(message.requestId) : ''
    const request: PendingRequest = {
      domain,
      requestId: id,
      message,
      mutation: options.mutation === true,
      sent: false,
      signal: options.signal,
      resolve: value => resolve(value as T),
      reject,
    }
    request.onAbort = () => cancelPending(request)
    pendingRequests.set(id, request)
    options.signal?.addEventListener('abort', request.onAbort, { once: true })
    if (options.timeoutMs && options.timeoutMs > 0) {
      request.timeout = setTimeout(() => {
        if (!pendingRequests.has(id)) return
        const uncertain = request.mutation && request.sent
        deletePending(request)
        if (request.sent && transportReady && transport) {
          transport({ type: 'workspace-cancel', requestId: request.requestId })
        }
        request.reject(requestError('TIMEOUT', 'Workspace request timed out', uncertain))
      }, options.timeoutMs)
    }
    sendPending(request)
  })
}

export function setWorkspaceRequestTransport(next: WorkspaceTransport | null): void {
  transport = next
  if (!next) setWorkspaceRequestTransportReady(false)
}

export function setWorkspaceRequestTransportReady(
  ready: boolean,
  maxInlineBytes = inlineMessageLimit,
): void {
  transportReady = ready && transport !== null
  inlineMessageLimit = Math.max(1, Math.min(maxInlineBytes, MAX_INLINE_WORKSPACE_MESSAGE_BYTES))
  if (!transportReady) {
    for (const request of [...pendingRequests.values()]) {
      if (!request.sent) continue
      if (request.mutation) {
        deletePending(request)
        request.reject(requestError('DISCONNECTED', 'Workspace mutation connection was lost', true))
      } else {
        request.sent = false
      }
    }
    return
  }
  for (const request of pendingRequests.values()) {
    if (!sendPending(request)) break
  }
}

export function workspaceInlineMessageLimit(): number {
  return inlineMessageLimit
}

export function requestWorkspace<T>(
  request: WorkspaceRequest,
  options: { mutation?: boolean; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<T> {
  const id = requestId('workspace')
  return createRequest<T>('workspace', {
    type: 'workspace-request',
    requestId: id,
    request,
  }, options)
}

export function requestLanguageServerTransport<T>(
  request: LanguageServerRequestPayload,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<{ result: T; supported: boolean }> {
  const id = requestId('language-server')
  return createRequest<{ result: T; supported: boolean }>('language-server', {
    type: 'language-server-request',
    requestId: id,
    request,
  }, { signal: options.signal, timeoutMs: options.timeoutMs })
}

function settle(
  message: WorkspaceResultMessage | LanguageServerResultMessage,
  domain: RequestDomain,
): boolean {
  const request = pendingRequests.get(message.requestId)
  if (!request || request.domain !== domain) return false
  deletePending(request)
  if (!message.ok) {
    request.reject(new WorkspaceTransportError(message.error!))
    return true
  }
  request.resolve(domain === 'language-server'
    ? { result: message.result, supported: message.supported !== false }
    : message.result)
  return true
}

export function settleWorkspaceRequest(message: WorkspaceResultMessage): boolean {
  return settle(message, 'workspace')
}

export function settleLanguageServerRequest(message: LanguageServerResultMessage): boolean {
  return settle(message, 'language-server')
}
