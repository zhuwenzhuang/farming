import { useEffect, useRef, useState } from 'react'
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

export interface CodexModelCatalogPorts {
  fetchCatalog: (homeId: string) => Promise<CodexModelOption[]>
  publishOptions: (options: CodexModelOption[]) => void
  now: () => number
  isConnected: () => boolean
  reportError: (message: string) => void
}

/**
 * Owns the Codex model catalog cache, request admission, and recovery state.
 *
 * A catalog belongs to exactly one provider home: switching homes drops the
 * visible options immediately, and only the newest request for the requested
 * home may publish options or report a failure.
 */
export class CodexModelCatalogLifecycle {
  private readonly fence = new LatestRequestFence()
  private currentHomeId: string | null = null
  private loadedAt = 0
  private loadedHomeId = ''
  private loadedOptions: CodexModelOption[] = []
  private retryOnReconnect = false

  constructor(private readonly ports: CodexModelCatalogPorts) {}

  syncHome(homeId: string) {
    if (this.currentHomeId === homeId) return
    this.currentHomeId = homeId
    this.fence.invalidate()
    this.retryOnReconnect = false
    this.ports.publishOptions(this.isCached(homeId) ? this.loadedOptions : [])
  }

  load(homeId: string) {
    const homeChanged = this.currentHomeId !== homeId
    if (homeChanged) {
      this.currentHomeId = homeId
      this.fence.invalidate()
      this.retryOnReconnect = false
    }
    if (this.isCached(homeId)) {
      if (homeChanged) this.ports.publishOptions(this.loadedOptions)
      return () => {}
    }

    const lease = this.fence.begin()
    this.ports.publishOptions([])
    this.ports.fetchCatalog(homeId)
      .then(options => {
        if (!lease.isCurrent()) return
        if (options.length === 0) throw new Error(EMPTY_CATALOG_ERROR)
        this.loadedAt = this.ports.now()
        this.loadedHomeId = homeId
        this.loadedOptions = options
        this.retryOnReconnect = false
        this.ports.publishOptions(options)
      })
      .catch(error => {
        if (!lease.isCurrent()) return
        this.loadedAt = 0
        this.loadedHomeId = ''
        this.loadedOptions = []
        if (!this.ports.isConnected()) {
          this.retryOnReconnect = true
          return
        }
        this.retryOnReconnect = false
        this.ports.reportError(error instanceof Error ? error.message : CATALOG_LOAD_ERROR)
      })

    return () => {
      if (lease.isCurrent()) this.fence.invalidate()
    }
  }

  retryAfterReconnect(homeId: string) {
    if (!this.retryOnReconnect) return
    this.retryOnReconnect = false
    this.load(homeId)
  }

  stopReconnectRetry() {
    this.fence.invalidate()
    this.retryOnReconnect = false
  }

  dispose() {
    this.fence.invalidate()
    this.retryOnReconnect = false
  }

  private isCached(homeId: string) {
    return this.loadedHomeId === homeId
      && this.loadedAt > 0
      && this.ports.now() - this.loadedAt <= CODEX_MODEL_CATALOG_TTL_MS
  }
}

export interface CodexModelCatalogControllerOptions {
  providerHomeId: string
  enabled: boolean
  onError: (message: string) => void
}

export function useCodexModelCatalogController({
  providerHomeId,
  enabled,
  onError,
}: CodexModelCatalogControllerOptions) {
  const [codexModelOptions, setCodexModelOptions] = useState<CodexModelOption[]>([])
  const onErrorRef = useRef(onError)
  onErrorRef.current = onError

  const lifecycleRef = useRef<CodexModelCatalogLifecycle | null>(null)
  if (lifecycleRef.current === null) {
    lifecycleRef.current = new CodexModelCatalogLifecycle({
      fetchCatalog: homeId => requestCodexModelCatalog(homeId),
      publishOptions: setCodexModelOptions,
      now: () => Date.now(),
      isConnected: () => getBackendConnectionSnapshot().connected,
      reportError: message => onErrorRef.current(message),
    })
  }
  const lifecycle = lifecycleRef.current

  useEffect(() => {
    lifecycle.syncHome(providerHomeId)
  }, [lifecycle, providerHomeId])

  useEffect(() => {
    if (!enabled) return undefined
    return lifecycle.load(providerHomeId)
  }, [enabled, lifecycle, providerHomeId])

  useEffect(() => {
    if (!enabled) {
      lifecycle.stopReconnectRetry()
      return undefined
    }
    const retryRecoverableLoad = () => lifecycle.retryAfterReconnect(providerHomeId)
    window.addEventListener('farming:backend-connected', retryRecoverableLoad)
    return () => window.removeEventListener('farming:backend-connected', retryRecoverableLoad)
  }, [enabled, lifecycle, providerHomeId])

  useEffect(() => () => {
    lifecycle.dispose()
  }, [lifecycle])

  return codexModelOptions
}
