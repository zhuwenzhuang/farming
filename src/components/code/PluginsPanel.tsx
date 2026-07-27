import { useEffect, useMemo, useState } from 'react'
import { appPath } from '@/lib/base-path'
import { ArrowLeftGlyph, CloseGlyph, PuzzleGlyph } from '@/components/IconGlyphs'
import type { UiLanguage } from '@/lib/ui-preferences'
import type { BrowserCapability } from '../../../extensions/browser/frontend/types'

type AgentExtension = {
  id: string
  command: string
  name: string
  description: string
  kind: 'skill' | 'plugin' | 'command'
  scope: string
}

type AgentExtensionGroup = {
  id: string
  name: string
  description: string
  discoverySupported: boolean
  homes: Array<{
    id: string
    extensions: AgentExtension[]
  }>
}

type SelectedAgentExtension = AgentExtension & {
  agentName: string
  homeId: string
}

function pluginCopy(language: UiLanguage) {
  const zh = language === 'zh'
  return {
    title: zh ? '插件' : 'Plugins',
    description: zh ? '管理 Farming 和 Agent 可以使用的能力。' : 'Manage capabilities available to Farming and Agents.',
    back: zh ? '返回工作区' : 'Back to workspace',
    farmingBuiltIn: zh ? 'Farming 内置' : 'Built into Farming',
    farmingBuiltInDescription: zh ? '由 Farming 提供并统一管理的能力。' : 'Capabilities provided and managed by Farming.',
    agentExtensions: zh ? 'Agent 扩展' : 'Agent extensions',
    agentExtensionsDescription: zh ? '按 Agent 查看已安装的 Skill、插件和命令。' : 'Installed skills, plugins, and commands grouped by Agent.',
    loadingAgentExtensions: zh ? '正在读取 Agent 扩展…' : 'Loading Agent extensions…',
    agentExtensionsFailed: zh ? 'Agent 扩展读取失败' : 'Failed to load Agent extensions',
    noAgentExtensions: zh ? '没有发现 Skill、插件或命令。' : 'No skills, plugins, or commands found.',
    unsupportedDiscovery: zh ? '这个 Agent 还没有统一的扩展发现接口。' : 'This Agent does not expose a unified extension discovery interface yet.',
    home: zh ? 'Home' : 'Home',
    count: (count: number) => zh ? `${count} 项` : `${count} items`,
    kind: {
      skill: zh ? 'Skill' : 'Skill',
      plugin: zh ? '插件' : 'Plugin',
      command: zh ? '命令' : 'Command',
    },
    extensionDetails: zh ? '扩展详情' : 'Extension details',
    closeDetails: zh ? '关闭详情' : 'Close details',
    browser: zh ? '浏览器' : 'Browser',
    browserDescription: zh
      ? '让 Agent 操作网页，并在 Farming 中查看同一个浏览器。'
      : 'Let Agents operate webpages and view the same browser in Farming.',
    enabled: zh ? '已启用' : 'Enabled',
    disabled: zh ? '已停用' : 'Disabled',
    unavailable: zh ? '未就绪' : 'Not ready',
    checking: zh ? '正在检查…' : 'Checking…',
    systemBrowser: zh ? '系统 Chromium' : 'System Chromium',
    externalBrowser: zh ? '外部 CDP' : 'External CDP',
    unavailableHint: zh
      ? '需要兼容的 Chromium 浏览器，或本机回环地址上的外部 CDP。'
      : 'Requires a compatible Chromium browser or an external CDP endpoint on loopback.',
    enable: zh ? '启用' : 'Enable',
    disable: zh ? '停用' : 'Disable',
    saveFailed: zh ? '浏览器插件设置保存失败' : 'Failed to save Browser plugin settings',
  }
}

function browserSource(capability: BrowserCapability | null, copy: ReturnType<typeof pluginCopy>) {
  if (!capability?.browser) return ''
  return capability.browser.kind === 'external-cdp' ? copy.externalBrowser : copy.systemBrowser
}

function agentDisplayName(agent: Pick<AgentExtensionGroup, 'id' | 'name'>) {
  if (agent.id === 'codex') return 'Codex'
  if (agent.id === 'claude') return 'Claude Code'
  if (agent.id === 'opencode') return 'OpenCode'
  if (agent.id === 'qoder') return 'Qoder'
  return agent.name || agent.id
}

export function PluginsPanel({
  capability,
  loading,
  language,
  onBack,
  onRefreshCapability,
}: {
  capability: BrowserCapability | null
  loading: boolean
  language: UiLanguage
  onBack: () => void
  onRefreshCapability: () => void
}) {
  const copy = useMemo(() => pluginCopy(language), [language])
  const [enabled, setEnabled] = useState(capability?.enabled === true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [agentGroups, setAgentGroups] = useState<AgentExtensionGroup[]>([])
  const [agentGroupsLoading, setAgentGroupsLoading] = useState(true)
  const [agentGroupsError, setAgentGroupsError] = useState('')
  const [selectedExtension, setSelectedExtension] = useState<SelectedAgentExtension | null>(null)

  useEffect(() => {
    if (capability) setEnabled(capability.enabled)
  }, [capability])

  useEffect(() => {
    const controller = new AbortController()
    setAgentGroupsLoading(true)
    setAgentGroupsError('')
    fetch(appPath('/api/agent-extensions'), {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    })
      .then(async response => {
        const data = await response.json().catch(() => ({})) as {
          agents?: AgentExtensionGroup[]
          error?: string
        }
        if (!response.ok) throw new Error(data.error || copy.agentExtensionsFailed)
        setAgentGroups(Array.isArray(data.agents) ? data.agents : [])
      })
      .catch(loadError => {
        if (loadError instanceof DOMException && loadError.name === 'AbortError') return
        setAgentGroupsError(loadError instanceof Error ? loadError.message : copy.agentExtensionsFailed)
      })
      .finally(() => {
        if (!controller.signal.aborted) setAgentGroupsLoading(false)
      })
    return () => controller.abort()
  }, [copy.agentExtensionsFailed])

  useEffect(() => {
    if (!selectedExtension) return undefined
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSelectedExtension(null)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [selectedExtension])

  const toggleBrowser = async () => {
    if (saving || (!capability?.browser && !enabled)) return
    const nextEnabled = !enabled
    setSaving(true)
    setError('')
    try {
      const response = await fetch(appPath('/api/settings'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ browserExtensionEnabled: nextEnabled }),
      })
      const data = await response.json().catch(() => ({})) as {
        error?: string
        settings?: { browserExtensionEnabled?: boolean }
      }
      if (!response.ok) throw new Error(data.error || copy.saveFailed)
      setEnabled(data.settings?.browserExtensionEnabled === true)
      onRefreshCapability()
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : copy.saveFailed)
    } finally {
      setSaving(false)
    }
  }

  const browserReady = Boolean(capability?.browser)
  const status = loading && capability === null
    ? copy.checking
    : browserReady
      ? enabled ? copy.enabled : copy.disabled
      : copy.unavailable

  return (
    <div className="code-plugins-panel" data-testid="code-plugins-panel">
      <header className="code-plugins-panel-header">
        <button type="button" onClick={onBack} aria-label={copy.back} title={copy.back}>
          <ArrowLeftGlyph />
        </button>
        <div>
          <h2>{copy.title}</h2>
          <p>{copy.description}</p>
        </div>
      </header>

      <section className="code-plugin-section" data-testid="code-plugin-section-farming">
        <header className="code-plugin-section-header">
          <div>
            <h3>{copy.farmingBuiltIn}</h3>
            <p>{copy.farmingBuiltInDescription}</p>
          </div>
        </header>
        <article className="code-plugin-card" data-testid="code-plugin-browser">
          <span className="code-plugin-card-icon" aria-hidden="true">
            <PuzzleGlyph />
          </span>
          <div className="code-plugin-card-copy">
            <div className="code-plugin-card-title">
              <h3>{copy.browser}</h3>
              <span className={`code-plugin-status ${browserReady && enabled ? 'enabled' : ''}`}>{status}</span>
            </div>
            <p>{copy.browserDescription}</p>
            {browserReady ? (
              <small>{browserSource(capability, copy)}</small>
            ) : (
              <small>{copy.unavailableHint}</small>
            )}
            {error && <div className="code-plugin-error" role="alert">{error}</div>}
          </div>
          <button
            type="button"
            className={`code-plugin-toggle ${enabled ? 'active' : ''}`}
            aria-pressed={enabled}
            disabled={saving || (!browserReady && !enabled)}
            onClick={() => void toggleBrowser()}
          >
            {enabled ? copy.disable : copy.enable}
          </button>
        </article>
      </section>

      <div className="code-plugin-agent-sections" data-testid="code-plugin-agent-sections">
        <header className="code-plugin-agent-sections-header">
          <h3>{copy.agentExtensions}</h3>
          <p>{copy.agentExtensionsDescription}</p>
        </header>
        {agentGroupsLoading ? (
          <p className="code-plugin-empty">{copy.loadingAgentExtensions}</p>
        ) : agentGroupsError ? (
          <div className="code-plugin-error" role="alert">{agentGroupsError}</div>
        ) : agentGroups.map(agent => {
          const extensionCount = agent.homes.reduce((count, home) => count + home.extensions.length, 0)
          return (
            <section
              key={agent.id}
              className="code-plugin-section code-plugin-agent-section"
              data-testid={`code-plugin-section-agent-${agent.id}`}
            >
              <header className="code-plugin-section-header">
                <div>
                  <h3>{agentDisplayName(agent)}</h3>
                  <p>{agent.description}</p>
                </div>
                <span>{copy.count(extensionCount)}</span>
              </header>
              {!agent.discoverySupported ? (
                <p className="code-plugin-empty">{copy.unsupportedDiscovery}</p>
              ) : extensionCount === 0 ? (
                <p className="code-plugin-empty">{copy.noAgentExtensions}</p>
              ) : agent.homes.map(home => (
                <div className="code-plugin-agent-home" key={home.id}>
                  {agent.homes.length > 1 || home.id !== 'default' ? (
                    <h4>{copy.home}: {home.id}</h4>
                  ) : null}
                  <div className="code-plugin-extension-list">
                    {home.extensions.map(extension => (
                      <button
                        type="button"
                        className="code-plugin-extension"
                        key={`${home.id}:${extension.id}`}
                        onClick={() => setSelectedExtension({
                          ...extension,
                          agentName: agentDisplayName(agent),
                          homeId: home.id,
                        })}
                      >
                        <div className="code-plugin-extension-title">
                          <strong>{extension.name}</strong>
                          <span>{copy.kind[extension.kind]}</span>
                        </div>
                        <div className="code-plugin-extension-meta">
                          <code>{extension.command}</code>
                          {extension.scope ? <span>{extension.scope}</span> : null}
                        </div>
                        <p>{extension.description}</p>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </section>
          )
        })}
      </div>

      {selectedExtension ? (
        <div
          className="code-plugin-detail-backdrop"
          role="presentation"
          onPointerDown={() => setSelectedExtension(null)}
        >
          <section
            className="code-plugin-detail-dialog"
            data-testid="code-plugin-detail-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="code-plugin-detail-title"
            onPointerDown={event => event.stopPropagation()}
          >
            <header>
              <div>
                <small>{selectedExtension.agentName} · {copy.extensionDetails}</small>
                <h3 id="code-plugin-detail-title">{selectedExtension.name}</h3>
              </div>
              <button
                type="button"
                autoFocus
                aria-label={copy.closeDetails}
                title={copy.closeDetails}
                onClick={() => setSelectedExtension(null)}
              >
                <CloseGlyph />
              </button>
            </header>
            <div className="code-plugin-detail-meta">
              <span>{copy.kind[selectedExtension.kind]}</span>
              <code>{selectedExtension.command}</code>
              {selectedExtension.scope ? <span>{selectedExtension.scope}</span> : null}
              {selectedExtension.homeId !== 'default' ? <span>{copy.home}: {selectedExtension.homeId}</span> : null}
            </div>
            <p>{selectedExtension.description}</p>
          </section>
        </div>
      ) : null}
    </div>
  )
}
