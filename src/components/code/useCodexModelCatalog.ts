import { useCallback, useEffect, useRef, useState } from 'react'
import { appPath } from '@/lib/base-path'
import { getBackendConnectionSnapshot } from '@/lib/backend-live-status'
import { LatestRequestFence } from './latest-request-fence'
import { normalizeModelCatalog } from './model'
import type { CodexModelOption } from './types'

const EMPTY_CATALOG_ERROR = 'Codex model catalog did not contain any visible models'
const CATALOG_LOAD_ERROR = 'Failed to load Codex model catalog'

type CodexModelCatalogResponse = {
  catalog?: CodexModelOption[]
  error?: string
}

type CodexModelCatalogRequest = (url: string, init?: RequestInit) => Promise<{
  ok: boolean
  status: number
  json(): Promise<unknown>
}>

export async function requestCodexModelCatalog(
  homeId: string,
  request: CodexModelCatalogRequest = fetch,
) {
  const params = new URLSearchParams({ homeId })
  const controller = new AbortController()
  const timer = globalThis.setTimeout(() => controller.abort(), 20_000)
  try {
    const response = await request(appPath(`/api/codex/models?${params.toString()}`), { signal: controller.signal })
    const data = await response.json().catch(() => ({})) as CodexModelCatalogResponse
    if (!response.ok) throw new Error(data.error || `${CATALOG_LOAD_ERROR} (${response.status})`)
    return normalizeModelCatalog(data)
  } finally { globalThis.clearTimeout(timer) }
}

export interface CodexModelCatalogOptions {
  providerHomeId: string
  enabled: boolean
  onError: (message: string) => void
}

export function useCodexModelCatalog({
  providerHomeId,
  enabled,
  onError,
}: CodexModelCatalogOptions) {
  const [codexModelOptions, setCodexModelOptions] = useState<CodexModelOption[]>([])
  const requestFenceRef = useRef(new LatestRequestFence())
  const retryOnReconnectRef = useRef(false)
  const onErrorRef = useRef(onError)
  onErrorRef.current = onError

  const loadCatalog = useCallback((homeId: string) => {
    const lease = requestFenceRef.current.begin()
    setCodexModelOptions([])
    void requestCodexModelCatalog(homeId)
      .then(options => {
        if (!lease.isCurrent()) return
        if (options.length === 0) throw new Error(EMPTY_CATALOG_ERROR)
        retryOnReconnectRef.current = false
        setCodexModelOptions(options)
      })
      .catch(error => {
        if (!lease.isCurrent()) return
        if (!getBackendConnectionSnapshot().connected) {
          retryOnReconnectRef.current = true
          return
        }
        retryOnReconnectRef.current = false
        onErrorRef.current(error instanceof Error ? error.message : CATALOG_LOAD_ERROR)
      })
  }, [])

  useEffect(() => {
    requestFenceRef.current.invalidate()
    retryOnReconnectRef.current = false
    setCodexModelOptions([])
  }, [providerHomeId])

  useEffect(() => {
    const requestFence = requestFenceRef.current
    if (!enabled) {
      requestFence.invalidate()
      retryOnReconnectRef.current = false
      return undefined
    }
    loadCatalog(providerHomeId)
    return () => requestFence.invalidate()
  }, [enabled, loadCatalog, providerHomeId])

  useEffect(() => {
    if (!enabled) return undefined
    const retryAfterReconnect = () => {
      if (!retryOnReconnectRef.current) return
      retryOnReconnectRef.current = false
      loadCatalog(providerHomeId)
    }
    window.addEventListener('farming:backend-connected', retryAfterReconnect)
    return () => window.removeEventListener('farming:backend-connected', retryAfterReconnect)
  }, [enabled, loadCatalog, providerHomeId])

  return codexModelOptions
}
