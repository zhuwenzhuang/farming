import { useEffect, useRef, useState } from 'react'
import { appPath } from '@/lib/base-path'
import type { SlashCommandOption } from './capabilities'
import {
  DEFAULT_CLAUDE_SETTINGS,
  normalizeClaudeSettingsSummary,
  type ClaudeSettingsSummary,
} from './composer-profile'
import { LatestRequestFence } from './latest-request-fence'

type JsonRequest = (url: string) => Promise<{ json(): Promise<unknown> }>

export async function requestClaudeSettings(homeId: string, request: JsonRequest = fetch) {
  const params = new URLSearchParams({ homeId })
  const response = await request(appPath(`/api/claude/settings?${params.toString()}`))
  const data = await response.json() as { settings?: ClaudeSettingsSummary }
  return normalizeClaudeSettingsSummary(data.settings)
}

export async function requestSlashCommands(
  provider: string,
  homeId: string,
  workspace?: string,
  request: JsonRequest = fetch,
) {
  const params = new URLSearchParams({ provider, homeId })
  if (workspace) params.set('workspace', workspace)
  const response = await request(appPath(`/api/slash-commands?${params.toString()}`))
  const data = await response.json() as { commands?: SlashCommandOption[] }
  return Array.isArray(data.commands) ? data.commands : []
}

export interface ComposerProviderCatalogTarget {
  providerKind: string
  homeId: string
  workspace?: string
  slashCommandDiscovery: boolean
}

export function useComposerProviderCatalog({
  providerKind,
  homeId,
  workspace,
  slashCommandDiscovery,
}: ComposerProviderCatalogTarget) {
  const [claudeSettings, setClaudeSettings] = useState<ClaudeSettingsSummary>(DEFAULT_CLAUDE_SETTINGS)
  const [discoveredSlashCommands, setDiscoveredSlashCommands] = useState<SlashCommandOption[]>([])
  const claudeRequestFenceRef = useRef(new LatestRequestFence())
  const slashRequestFenceRef = useRef(new LatestRequestFence())

  useEffect(() => {
    const requestFence = claudeRequestFenceRef.current
    const lease = requestFence.begin()
    if (providerKind !== 'claude') {
      setClaudeSettings(DEFAULT_CLAUDE_SETTINGS)
      return () => requestFence.invalidate()
    }
    void requestClaudeSettings(homeId)
      .then(settings => {
        if (lease.isCurrent()) setClaudeSettings(settings)
      })
      .catch(() => {
        if (lease.isCurrent()) setClaudeSettings(DEFAULT_CLAUDE_SETTINGS)
      })
    return () => requestFence.invalidate()
  }, [homeId, providerKind])

  useEffect(() => {
    const requestFence = slashRequestFenceRef.current
    const lease = requestFence.begin()
    if (!slashCommandDiscovery || !providerKind) {
      setDiscoveredSlashCommands([])
      return () => requestFence.invalidate()
    }
    void requestSlashCommands(providerKind, homeId, workspace)
      .then(commands => {
        if (lease.isCurrent()) setDiscoveredSlashCommands(commands)
      })
      .catch(() => {
        if (lease.isCurrent()) setDiscoveredSlashCommands([])
      })
    return () => requestFence.invalidate()
  }, [homeId, providerKind, slashCommandDiscovery, workspace])

  return { claudeSettings, discoveredSlashCommands }
}
