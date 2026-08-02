import {
  CodexRealtimeBackendError,
  type BackendStartRequest,
  type BackendStopRequest,
} from './codex-realtime-controller'

interface RealtimeHttpDependencies {
  fetch: typeof fetch
  buildPath: (path: string) => string
  scheduleTimeout: (callback: () => void, delayMs: number) => number
  clearScheduledTimeout: (timerId: number) => void
  startTimeoutMs?: number
  stopTimeoutMs?: number
}

const DEFAULT_START_TIMEOUT_MS = 30_000
const DEFAULT_STOP_TIMEOUT_MS = 15_000

class RealtimeHttpTimeoutError extends Error {
  constructor(label: string) {
    super(`${label} timed out`)
    this.name = 'RealtimeHttpTimeoutError'
  }
}

async function fetchJsonWithTimeout(
  dependencies: RealtimeHttpDependencies,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  label: string,
): Promise<{ response: Response, body: Record<string, unknown> | null }> {
  const controller = new AbortController()
  let rejectTimeout!: (error: Error) => void
  const timeout = new Promise<never>((_resolve, reject) => {
    rejectTimeout = reject
  })
  const timerId = dependencies.scheduleTimeout(() => {
    controller.abort()
    rejectTimeout(new RealtimeHttpTimeoutError(label))
  }, timeoutMs)
  const request = (async () => {
    const response = await dependencies.fetch(url, { ...init, signal: controller.signal })
    const body = await readJson(response)
    return { response, body }
  })()
  try {
    return await Promise.race([request, timeout])
  } finally {
    dependencies.clearScheduledTimeout(timerId)
  }
}

async function readJson(response: Response) {
  try {
    return await response.json() as Record<string, unknown>
  } catch {
    return null
  }
}

export function createCodexRealtimeHttpClient(dependencies: RealtimeHttpDependencies) {
  return {
    startBackend: async ({ agentId, operationId, sdp }: BackendStartRequest) => {
      let response: Response
      let body: Record<string, unknown> | null
      try {
        ({ response, body } = await fetchJsonWithTimeout(
          dependencies,
          dependencies.buildPath(`/api/agents/${encodeURIComponent(agentId)}/acp-realtime/start`),
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ operationId, sdp }),
          },
          dependencies.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS,
          'Codex realtime start request',
        ))
      } catch (error) {
        throw new CodexRealtimeBackendError(
          error instanceof Error ? error.message : 'Codex realtime start outcome is uncertain',
          'uncertain',
        )
      }
      if (!response.ok) {
        throw new CodexRealtimeBackendError(
          typeof body?.error === 'string' ? body.error : `Failed to start voice (${response.status})`,
          body?.outcome === 'rejected' ? 'rejected' : 'uncertain',
        )
      }
      if (body?.started === true && body.operationId === operationId) return { accepted: true }
      if (
        body?.started === false
        && body.cancelled === true
        && body.operationId === operationId
      ) return { accepted: false }
      throw new CodexRealtimeBackendError(
        'Codex realtime start returned an unverified response',
        'uncertain',
      )
    },

    stopBackend: async ({ agentId, operationId, keepalive }: BackendStopRequest) => {
      const { response, body } = await fetchJsonWithTimeout(
        dependencies,
        dependencies.buildPath(`/api/agents/${encodeURIComponent(agentId)}/acp-realtime/stop`),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ operationId }),
          keepalive,
        },
        dependencies.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS,
        'Codex realtime stop request',
      )
      if (!response.ok) {
        throw new Error(
          typeof body?.error === 'string' ? body.error : `Failed to stop voice (${response.status})`,
        )
      }
      if (body?.reconciled !== true || body.operationId !== operationId) {
        throw new Error('Codex realtime stop returned an unverified response')
      }
    },
  }
}
