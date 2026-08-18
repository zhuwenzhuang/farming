import {
  requestLanguageServerTransport,
  WorkspaceTransportError,
} from '@/lib/workspace-request-client'
import type {
  LanguageServerCapability,
  LanguageServerRequest,
} from './types'

const REQUEST_TIMEOUT_MS = 60_000

export class LanguageServerError extends Error {
  readonly status: number
  readonly code: string

  constructor(message: string, status: number, code: string) {
    super(message)
    this.name = 'LanguageServerError'
    this.status = status
    this.code = code
  }

  get unavailable(): boolean {
    return this.status === 503
      || this.code === 'LANGUAGE_SERVER_UNAVAILABLE'
      || this.code === 'LANGUAGE_SERVER_WORKSPACE_UNAVAILABLE'
  }
}

async function transportRequest<T>(
  request: Parameters<typeof requestLanguageServerTransport<T>>[0],
  signal?: AbortSignal,
) {
  try {
    return await requestLanguageServerTransport<T>(request, {
      signal,
      timeoutMs: REQUEST_TIMEOUT_MS,
    })
  } catch (error) {
    if (error instanceof WorkspaceTransportError) {
      if (error.code === 'TIMEOUT') {
        throw new LanguageServerError(error.message, 504, 'LANGUAGE_SERVER_REQUEST_TIMEOUT')
      }
      throw new LanguageServerError(error.message, error.status, error.code)
    }
    throw error
  }
}

export async function fetchLanguageServerCapability(refresh = false): Promise<LanguageServerCapability> {
  return (await transportRequest<LanguageServerCapability>({
    operation: 'capability',
    force: refresh,
  })).result
}

export async function requestLanguageServer<T>(request: LanguageServerRequest, options: { signal?: AbortSignal } = {}): Promise<T> {
  return (await requestLanguageServerOutcome<T>(request, options)).result
}

export async function requestLanguageServerOutcome<T>(
  request: LanguageServerRequest,
  options: { signal?: AbortSignal } = {},
): Promise<{ result: T; supported: boolean }> {
  return transportRequest<T>({ operation: 'request', ...request }, options.signal)
}
