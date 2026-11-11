import { useEffect, useRef, useState } from 'react'
import { appPath } from '@/lib/base-path'
import type { SlashCommandOption } from './capabilities'
import {
  DEFAULT_CLAUDE_SETTINGS,
  normalizeClaudeSettingsSummary,
  type ClaudeSettingsSummary,
} from './composer-profile'
import { normalizeModelCatalog } from './model'
import { LatestRequestFence } from './latest-request-fence'
import { useCodexModelCatalog } from './useCodexModelCatalog'

export type SlashCatalogStatus = 'disabled' | 'loading' | 'ready' | 'error'

interface SlashCatalogState {
  targetKey: string
  status: SlashCatalogStatus
  commands: SlashCommandOption[]
}

type JsonRequest = (
  url: string,
  init?: RequestInit,
) => Promise<{ ok?: boolean; json(): Promise<unknown> }>

export const SLASH_COMMAND_REQUEST_TIMEOUT_MS = 8_000

export async function requestClaudeSettings(homeId: string, request: JsonRequest = fetch) {
  const params = new URLSearchParams({ homeId })
  const controller = new AbortController()
  const timer = globalThis.setTimeout(() => controller.abort(), 20_000)
  try {
    const response = await request(appPath(`/api/claude/models?${params.toString()}`), { signal: controller.signal })
    const data = await response.json() as { error?: string; catalog?: import('./types').CodexModelOption[] }
    if (response.ok === false) throw new Error(data.error || 'Failed to load Claude model catalog')
    const modelOptions = normalizeModelCatalog(data)
    if (!modelOptions.length) throw new Error('Claude model catalog returned no models')
    return normalizeClaudeSettingsSummary({ available: true, modelOptions })
  } finally { globalThis.clearTimeout(timer) }
}

export async function requestSlashCommands(
  provider: string,
  homeId: string,
  workspace?: string,
  request: JsonRequest = fetch,
  timeoutMs = SLASH_COMMAND_REQUEST_TIMEOUT_MS,
  signal?: AbortSignal,
) {
  const params = new URLSearchParams({ provider, homeId })
  if (workspace) params.set('workspace', workspace)
  const controller = new AbortController()
  const abortFromCaller = () => controller.abort()
  if (signal?.aborted) controller.abort()
  else signal?.addEventListener('abort', abortFromCaller, { once: true })
  const timeout = globalThis.setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await request(
      appPath(`/api/slash-commands?${params.toString()}`),
      { signal: controller.signal },
    )
    if (response.ok === false) throw new Error('Slash command discovery failed')
    const data = await response.json() as { commands?: SlashCommandOption[] }
    return Array.isArray(data.commands) ? data.commands : []
  } finally {
    globalThis.clearTimeout(timeout)
    signal?.removeEventListener('abort', abortFromCaller)
  }
}

export interface ComposerProviderCatalogTarget {
  providerKind: string
  homeId: string
  workspace?: string
  slashCommandDiscovery: boolean
  modelCatalogOpen: boolean
  onModelCatalogError: (message: string) => void
}

interface ComposerProviderCatalogAdapter {
  codexModelCatalog?: boolean
  loadSettings?: (homeId: string) => Promise<ClaudeSettingsSummary>
}

const COMPOSER_PROVIDER_CATALOG_ADAPTERS: Record<string, ComposerProviderCatalogAdapter> = {
  codex: { codexModelCatalog: true },
  claude: { loadSettings: requestClaudeSettings },
}

export function useComposerProviderCatalog({
  providerKind,
  homeId,
  workspace,
  slashCommandDiscovery,
  modelCatalogOpen,
  onModelCatalogError,
}: ComposerProviderCatalogTarget) {
  const adapter = COMPOSER_PROVIDER_CATALOG_ADAPTERS[providerKind]
  const onErrorRef = useRef(onModelCatalogError)
  onErrorRef.current = onModelCatalogError
  const modelOptions = useCodexModelCatalog({
    providerHomeId: homeId,
    enabled: modelCatalogOpen && adapter?.codexModelCatalog === true,
    onError: onModelCatalogError,
  })
  const [claudeSettings, setClaudeSettings] = useState<ClaudeSettingsSummary>(DEFAULT_CLAUDE_SETTINGS)
  const slashCatalogTargetKey = JSON.stringify([providerKind, homeId, workspace || ''])
  const slashCatalogEnabled = Boolean(slashCommandDiscovery && providerKind)
  const [slashCatalog, setSlashCatalog] = useState<SlashCatalogState>({
    targetKey: '',
    status: 'disabled',
    commands: [],
  })
  const claudeRequestFenceRef = useRef(new LatestRequestFence())
  const slashRequestFenceRef = useRef(new LatestRequestFence())

  useEffect(() => {
    const requestFence = claudeRequestFenceRef.current
    const lease = requestFence.begin()
    setClaudeSettings(DEFAULT_CLAUDE_SETTINGS)
    if (!modelCatalogOpen || !adapter?.loadSettings) {
      setClaudeSettings(DEFAULT_CLAUDE_SETTINGS)
      return () => requestFence.invalidate()
    }
    void adapter.loadSettings(homeId)
      .then(settings => {
        if (lease.isCurrent()) setClaudeSettings(settings)
      })
      .catch(error => {
        if (lease.isCurrent()) onErrorRef.current(error instanceof Error ? error.message : 'Failed to load Claude model catalog')
      })
    return () => requestFence.invalidate()
  }, [adapter, homeId, modelCatalogOpen])

  useEffect(() => {
    const requestFence = slashRequestFenceRef.current
    const lease = requestFence.begin()
    const controller = new AbortController()
    if (!slashCatalogEnabled) {
      setSlashCatalog({ targetKey: slashCatalogTargetKey, status: 'disabled', commands: [] })
      return () => {
        controller.abort()
        requestFence.invalidate()
      }
    }
    setSlashCatalog({ targetKey: slashCatalogTargetKey, status: 'loading', commands: [] })
    void requestSlashCommands(
      providerKind,
      homeId,
      workspace,
      fetch,
      SLASH_COMMAND_REQUEST_TIMEOUT_MS,
      controller.signal,
    )
      .then(commands => {
        if (lease.isCurrent()) {
          setSlashCatalog({ targetKey: slashCatalogTargetKey, status: 'ready', commands })
        }
      })
      .catch(() => {
        if (lease.isCurrent()) {
          setSlashCatalog({ targetKey: slashCatalogTargetKey, status: 'error', commands: [] })
        }
      })
    return () => {
      controller.abort()
      requestFence.invalidate()
    }
  }, [homeId, providerKind, slashCatalogEnabled, slashCatalogTargetKey, workspace])

  const currentSlashCatalog = slashCatalog.targetKey === slashCatalogTargetKey
    ? slashCatalog
    : {
        targetKey: slashCatalogTargetKey,
        status: slashCatalogEnabled ? 'loading' as const : 'disabled' as const,
        commands: [],
      }

  return {
    claudeSettings,
    discoveredSlashCommands: currentSlashCatalog.commands,
    slashCatalogStatus: currentSlashCatalog.status,
    slashCatalogTargetKey,
    modelOptions,
  }
}
