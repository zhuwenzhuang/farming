import { useCallback, useEffect, useRef, useState } from 'react'
import { appPath } from '@/lib/base-path'
import { getBackendConnectionSnapshot } from '@/lib/backend-live-status'
import { LatestRequestFence } from './latest-request-fence'
import { normalizeModelCatalog } from './model'
import type { CodexModelOption } from './types'

export const CODEX_MODEL_CATALOG_TTL_MS = 5 * 60_000
const EMPTY_CATALOG_ERROR = 'Codex model catalog did not contain any visible models'
const CATALOG_LOAD_ERROR = 'Failed to load Codex model catalog'

type CodexModelCatalogResponse = {
  catalog?: CodexModelOption[]
  error?: string
}

type CodexModelCatalogRequest = (url: string) => Promise<{
  ok: boolean
  status: number
  json(): Promise<unknown>
}>

export async function requestCodexModelCatalog(
  homeId: string,
  request: CodexModelCatalogRequest = fetch,
) {
  const params = new URLSearchParams({ homeId })
  const response = await request(appPath(`/api/codex/models?${params.toString()}`))
  const data = await response.json().catch(() => ({})) as CodexModelCatalogResponse
  if (!response.ok) throw new Error(data.error || `${CATALOG_LOAD_ERROR} (${response.status})`)
  return normalizeModelCatalog(data)
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
  const cacheRef = useRef<{ homeId: string; loadedAt: number; options: CodexModelOption[] }>({
    homeId: '',
    loadedAt: 0,
    options: [],
  })
  const requestFenceRef = useRef(new LatestRequestFence())
  const retryOnReconnectRef = useRef(false)
  const onErrorRef = useRef(onError)
  onErrorRef.current = onError

  const loadCatalog = useCallback((homeId: string) => {
    const cache = cacheRef.current
    if (
      cache.homeId === homeId
      && cache.loadedAt > 0
      && Date.now() - cache.loadedAt <= CODEX_MODEL_CATALOG_TTL_MS
    ) {
      setCodexModelOptions(cache.options)
      return
    }

    const lease = requestFenceRef.current.begin()
    setCodexModelOptions([])
    void requestCodexModelCatalog(homeId)
      .then(options => {
        if (!lease.isCurrent()) return
        if (options.length === 0) throw new Error(EMPTY_CATALOG_ERROR)
        cacheRef.current = { homeId, loadedAt: Date.now(), options }
        retryOnReconnectRef.current = false
        setCodexModelOptions(options)
      })
      .catch(error => {
        if (!lease.isCurrent()) return
        cacheRef.current = { homeId: '', loadedAt: 0, options: [] }
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
    const cache = cacheRef.current
    const cached = cache.homeId === providerHomeId
      && cache.loadedAt > 0
      && Date.now() - cache.loadedAt <= CODEX_MODEL_CATALOG_TTL_MS
    setCodexModelOptions(cached ? cache.options : [])
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
