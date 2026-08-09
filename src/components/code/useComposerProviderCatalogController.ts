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

export function slashCommandsSupportProvider(providerKind: string) {
  return providerKind === 'codex' || providerKind === 'claude'
}

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
}

export interface ComposerProviderCatalogPorts {
  fetchClaudeSettings: (homeId: string) => Promise<ClaudeSettingsSummary>
  fetchSlashCommands: (provider: string, homeId: string, workspace?: string) => Promise<SlashCommandOption[]>
  publishClaudeSettings: (settings: ClaudeSettingsSummary) => void
  publishSlashCommands: (commands: SlashCommandOption[]) => void
}

/**
 * Owns Composer provider metadata reads with exact subresource identities:
 * Claude settings are keyed by provider/home, while slash commands are keyed
 * by provider/home/workspace.
 *
 * Claude settings only exist for the Claude provider and slash commands only for
 * Codex and Claude; every other kind resolves to the default metadata without a
 * request. Retargeting or disposing revokes older responses, so a late success or
 * failure can never overwrite the current target's metadata.
 */
export class ComposerProviderCatalogLifecycle {
  private readonly claudeFence = new LatestRequestFence()
  private readonly slashFence = new LatestRequestFence()
  private claudeTargetKey: string | null | undefined
  private slashTargetKey: string | null | undefined

  constructor(private readonly ports: ComposerProviderCatalogPorts) {}

  sync({ providerKind, homeId, workspace }: ComposerProviderCatalogTarget) {
    const claudeTargetKey = providerKind === 'claude' ? homeId : null
    if (this.claudeTargetKey !== claudeTargetKey) {
      this.claudeTargetKey = claudeTargetKey
      const lease = this.claudeFence.begin()

      if (claudeTargetKey !== null) {
        this.ports.fetchClaudeSettings(homeId)
          .then(settings => {
            if (lease.isCurrent()) this.ports.publishClaudeSettings(settings)
          })
          .catch(() => {
            if (lease.isCurrent()) this.ports.publishClaudeSettings(DEFAULT_CLAUDE_SETTINGS)
          })
      } else {
        this.ports.publishClaudeSettings(DEFAULT_CLAUDE_SETTINGS)
      }
    }

    const slashTargetKey = slashCommandsSupportProvider(providerKind)
      ? JSON.stringify([providerKind, homeId, workspace || ''])
      : null
    if (this.slashTargetKey !== slashTargetKey) {
      this.slashTargetKey = slashTargetKey
      const lease = this.slashFence.begin()

      if (slashTargetKey !== null) {
        this.ports.fetchSlashCommands(providerKind, homeId, workspace)
          .then(commands => {
            if (lease.isCurrent()) this.ports.publishSlashCommands(commands)
          })
          .catch(() => {
            if (lease.isCurrent()) this.ports.publishSlashCommands([])
          })
      } else {
        this.ports.publishSlashCommands([])
      }
    }
  }

  dispose() {
    this.claudeFence.invalidate()
    this.slashFence.invalidate()
    this.claudeTargetKey = undefined
    this.slashTargetKey = undefined
  }
}

export function useComposerProviderCatalogController({
  providerKind,
  homeId,
  workspace,
}: ComposerProviderCatalogTarget) {
  const [claudeSettings, setClaudeSettings] = useState<ClaudeSettingsSummary>(DEFAULT_CLAUDE_SETTINGS)
  const [discoveredSlashCommands, setDiscoveredSlashCommands] = useState<SlashCommandOption[]>([])

  const lifecycleRef = useRef<ComposerProviderCatalogLifecycle | null>(null)
  if (lifecycleRef.current === null) {
    lifecycleRef.current = new ComposerProviderCatalogLifecycle({
      fetchClaudeSettings: requestClaudeSettings,
      fetchSlashCommands: requestSlashCommands,
      publishClaudeSettings: setClaudeSettings,
      publishSlashCommands: setDiscoveredSlashCommands,
    })
  }
  const lifecycle = lifecycleRef.current

  useEffect(() => {
    lifecycle.sync({ providerKind, homeId, workspace })
  }, [homeId, lifecycle, providerKind, workspace])

  useEffect(() => () => {
    lifecycle.dispose()
  }, [lifecycle])

  return { claudeSettings, discoveredSlashCommands }
}
