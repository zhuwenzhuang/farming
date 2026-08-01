import { appPath } from '@/lib/base-path'
import type {
  LanguageServerCapability,
  LanguageServerRequest,
} from './types'

const REQUEST_TIMEOUT_MS = 12_000

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
  const data = await response.json().catch(() => ({})) as LanguageServerCapability & { error?: string }
  if (!response.ok) throw new Error(data.error || 'Failed to discover VS Code Bridge')
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
  const data = await response.json().catch(() => ({})) as { result?: T; supported?: boolean; error?: string }
  if (!response.ok) throw new Error(data.error || 'Language Server request failed')
  return { result: data.result as T, supported: data.supported !== false }
}
