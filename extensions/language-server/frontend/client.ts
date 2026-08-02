import { appPath } from '@/lib/base-path'
import type {
  LanguageServerCapability,
  LanguageServerRequest,
} from './types'

const REQUEST_TIMEOUT_MS = 12_000

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

async function fetchWithTimeout(url: string, init?: RequestInit) {
  const controller = new AbortController()
  const timeoutId = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    window.clearTimeout(timeoutId)
  }
}

export async function fetchLanguageServerCapability(refresh = false): Promise<LanguageServerCapability> {
  const response = await fetchWithTimeout(appPath(`/api/language-server/capability${refresh ? '?refresh=1' : ''}`), {
    headers: { Accept: 'application/json' },
  })
  const data = await response.json().catch(() => ({})) as LanguageServerCapability & { error?: string; code?: string }
  if (!response.ok) throw new LanguageServerError(
    data.error || 'Failed to discover VS Code Bridge',
    response.status,
    data.code || 'LANGUAGE_SERVER_ERROR',
  )
  return data
}

export async function requestLanguageServer<T>(request: LanguageServerRequest): Promise<T> {
  return (await requestLanguageServerOutcome<T>(request)).result
}

export async function requestLanguageServerOutcome<T>(request: LanguageServerRequest): Promise<{ result: T; supported: boolean }> {
  const response = await fetchWithTimeout(appPath('/api/language-server/request'), {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(request),
  })
  const data = await response.json().catch(() => ({})) as { result?: T; supported?: boolean; error?: string; code?: string }
  if (!response.ok) throw new LanguageServerError(
    data.error || 'Language Server request failed',
    response.status,
    data.code || 'LANGUAGE_SERVER_ERROR',
  )
  return { result: data.result as T, supported: data.supported !== false }
}
