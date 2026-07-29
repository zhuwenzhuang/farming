import { useEffect, useMemo, useRef, useState } from 'react'
import { appPath } from '@/lib/base-path'
import { getBackendConnectionSnapshot } from '@/lib/backend-live-status'
import { ArrowLeftGlyph, CloseGlyph, PuzzleGlyph } from '@/components/IconGlyphs'
import type { UiLanguage } from '@/lib/ui-preferences'
import type { BrowserCapability } from '../../../extensions/browser/frontend/types'

type AgentExtension = {
  id: string
  command: string
  name: string
  description: string
  kind: string
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

const EXTENSION_KIND_ORDER = ['plugin', 'skill', 'command']

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
    managedBrowser: zh ? 'Farming 内置 Chromium' : 'Farming-managed Chromium',
    managedBrowserNotInstalled: zh ? 'Farming 内置 Chromium（未安装）' : 'Farming-managed Chromium (not installed)',
    externalBrowser: zh ? '外部 CDP' : 'External CDP',
    browserChoice: zh ? '浏览器来源' : 'Browser source',
    automaticBrowser: zh ? '自动选择可用 Chromium' : 'Choose an available Chromium automatically',
    externalCdpAddress: zh ? 'CDP 地址' : 'CDP address',
    externalCdpPlaceholder: 'http://127.0.0.1:9222',
    applyBrowser: zh ? '应用' : 'Apply',
    installManagedBrowser: zh ? '安装内置 Chromium' : 'Install managed Chromium',
    updateManagedBrowser: zh ? '更新内置 Chromium' : 'Update managed Chromium',
    installingManagedBrowser: zh ? '正在安装…' : 'Installing…',
    managedBrowserInstallHint: zh
      ? '按需从 Chrome for Testing 下载；macOS arm64 当前约 178 MB，实际大小随平台和版本变化。文件只保存在 Farming 运行时目录。'
      : 'Downloads Chrome for Testing on demand; macOS arm64 is currently about 178 MB, and size varies by platform and version. Files stay in Farming runtime storage.',
    managedBrowserInstallFailed: zh ? '内置 Chromium 安装失败' : 'Failed to install managed Chromium',
    browserChangeHint: zh
      ? '切换后，正在运行的浏览器会停止。'
      : 'Changing this stops running Browsers.',
    unavailableHint: zh
      ? '可以安装 Farming 内置 Chromium、选择系统浏览器，或使用本机回环地址上的外部 CDP。'
      : 'Install Farming-managed Chromium, choose a system browser, or use an external CDP endpoint on loopback.',
    enable: zh ? '启用' : 'Enable',
    disable: zh ? '停用' : 'Disable',
    saveFailed: zh ? '浏览器插件设置保存失败' : 'Failed to save Browser plugin settings',
  }
}

function browserSource(capability: BrowserCapability | null, copy: ReturnType<typeof pluginCopy>) {
  if (!capability?.browser) return ''
  if (capability.browser.kind === 'managed-chromium') return copy.managedBrowser
  return capability.browser.kind === 'external-cdp' ? copy.externalBrowser : copy.systemBrowser
}

function browserKindName(kind: string) {
  if (kind === 'chrome') return 'Google Chrome'
  if (kind === 'brave') return 'Brave'
  if (kind === 'edge') return 'Microsoft Edge'
  if (kind === 'managed-chromium') return 'Farming Chromium'
  if (kind === 'chromium') return 'Chromium'
  return 'Chromium'
}

function agentDisplayName(agent: Pick<AgentExtensionGroup, 'id' | 'name'>) {
  if (agent.id === 'codex') return 'Codex'
  if (agent.id === 'claude') return 'Claude Code'
  if (agent.id === 'opencode') return 'OpenCode'
  if (agent.id === 'qoder') return 'Qoder'
  return agent.name || agent.id
}

function extensionKindLabel(kind: string, copy: ReturnType<typeof pluginCopy>) {
  if (kind === 'skill' || kind === 'plugin' || kind === 'command') return copy.kind[kind]
  return kind
    .split(/[-_.]+/)
    .filter(Boolean)
    .map(part => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(' ') || kind
}

function agentExtensionKindGroups(agent: AgentExtensionGroup) {
  const groups = new Map<string, Array<AgentExtension & { homeId: string }>>()
  agent.homes.forEach(home => {
    home.extensions.forEach(extension => {
      const entries = groups.get(extension.kind) || []
      entries.push({ ...extension, homeId: home.id })
      groups.set(extension.kind, entries)
    })
  })
  return [...groups.entries()]
    .map(([kind, extensions]) => ({ kind, extensions }))
    .sort((left, right) => {
      const leftIndex = EXTENSION_KIND_ORDER.indexOf(left.kind)
      const rightIndex = EXTENSION_KIND_ORDER.indexOf(right.kind)
      if (leftIndex === -1 && rightIndex === -1) return left.kind.localeCompare(right.kind)
      if (leftIndex === -1) return 1
      if (rightIndex === -1) return -1
      return leftIndex - rightIndex
    })
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
  const [installing, setInstalling] = useState(false)
  const [error, setError] = useState('')
  const [browserChoice, setBrowserChoice] = useState('system:')
  const [externalCdpUrl, setExternalCdpUrl] = useState('http://127.0.0.1:9222')
  const browserChoiceDirtyRef = useRef(false)
  const [agentGroups, setAgentGroups] = useState<AgentExtensionGroup[]>([])
  const [agentGroupsLoading, setAgentGroupsLoading] = useState(true)
  const [agentGroupsError, setAgentGroupsError] = useState('')
  const [selectedExtension, setSelectedExtension] = useState<SelectedAgentExtension | null>(null)

  useEffect(() => {
    if (!capability || browserChoiceDirtyRef.current) return
    setEnabled(capability.enabled)
    const selection = capability.selection
    setBrowserChoice(selection?.source === 'external-cdp'
      ? 'external-cdp'
      : selection?.source === 'managed'
        ? 'managed'
        : `system:${selection?.executablePath || ''}`)
    setExternalCdpUrl(selection?.externalCdpUrl || 'http://127.0.0.1:9222')
  }, [capability])

  useEffect(() => {
    let controller = new AbortController()
    let retryOnReconnect = false
    let requestSequence = 0
    const loadAgentGroups = () => {
      controller.abort()
      const requestController = new AbortController()
      controller = requestController
      const requestId = ++requestSequence
      setAgentGroupsLoading(true)
      setAgentGroupsError('')
      fetch(appPath('/api/agent-extensions'), {
        headers: { Accept: 'application/json' },
        signal: requestController.signal,
      })
        .then(async response => {
          const data = await response.json().catch(() => ({})) as {
            agents?: AgentExtensionGroup[]
            error?: string
          }
          if (!response.ok) throw new Error(data.error || copy.agentExtensionsFailed)
          retryOnReconnect = false
          setAgentGroups(Array.isArray(data.agents) ? data.agents : [])
        })
        .catch(loadError => {
          if (loadError instanceof DOMException && loadError.name === 'AbortError') return
          if (!getBackendConnectionSnapshot().connected) {
            retryOnReconnect = true
            return
          }
          setAgentGroupsError(loadError instanceof Error ? loadError.message : copy.agentExtensionsFailed)
        })
        .finally(() => {
          if (
            requestId === requestSequence
            && !requestController.signal.aborted
            && !retryOnReconnect
          ) setAgentGroupsLoading(false)
        })
    }
    const retryRecoverableLoad = () => {
      if (!retryOnReconnect) return
      retryOnReconnect = false
      loadAgentGroups()
    }
    window.addEventListener('farming:backend-connected', retryRecoverableLoad)
    loadAgentGroups()
    return () => {
      controller.abort()
      window.removeEventListener('farming:backend-connected', retryRecoverableLoad)
    }
  }, [copy.agentExtensionsFailed])

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

  const saveBrowserChoice = async () => {
    if (saving || !browserChoiceDirty) return
    const source = browserChoice === 'external-cdp'
      ? 'external-cdp'
      : browserChoice === 'managed'
        ? 'managed'
        : 'system'
    const executablePath = source === 'system' ? browserChoice.slice('system:'.length) : ''
    setSaving(true)
    setError('')
    try {
      const response = await fetch(appPath('/api/settings'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          browserSource: source,
          browserExecutablePath: executablePath,
          browserExternalCdpUrl: externalCdpUrl,
        }),
      })
      const data = await response.json().catch(() => ({})) as { error?: string }
      if (!response.ok) throw new Error(data.error || copy.saveFailed)
      browserChoiceDirtyRef.current = false
      onRefreshCapability()
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : copy.saveFailed)
    } finally {
      setSaving(false)
    }
  }

  const installManagedBrowser = async () => {
    if (installing) return
    setInstalling(true)
    setError('')
    try {
      const response = await fetch(appPath('/api/browsers/install'), {
        method: 'POST',
        headers: { Accept: 'application/json' },
      })
      const data = await response.json().catch(() => ({})) as { error?: string }
      if (!response.ok) throw new Error(data.error || copy.managedBrowserInstallFailed)
      onRefreshCapability()
    } catch (installError) {
      setError(installError instanceof Error ? installError.message : copy.managedBrowserInstallFailed)
      onRefreshCapability()
    } finally {
      setInstalling(false)
    }
  }

  const browserReady = Boolean(capability?.browser)
  const savedBrowserChoice = capability?.selection?.source === 'external-cdp'
    ? 'external-cdp'
    : capability?.selection?.source === 'managed'
      ? 'managed'
      : `system:${capability?.selection?.executablePath || ''}`
  const installation = capability?.installation
  const managedBrowserReady = installation?.state === 'ready'
  const managedBrowserInstalling = installing || installation?.state === 'installing'
  const showManagedBrowserInstall = managedBrowserInstalling
    || installation?.updateAvailable === true
    || (
      !browserReady
      && (installation?.state === 'absent' || installation?.state === 'failed')
    )
  const browserChoiceDirty = browserChoice !== savedBrowserChoice
    || (
      browserChoice === 'external-cdp'
      && externalCdpUrl.trim() !== (capability?.selection?.externalCdpUrl || '').trim()
    )
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
            <div className="code-plugin-browser-settings">
              <label>
                <span>{copy.browserChoice}</span>
                <select
                  value={browserChoice}
                  disabled={saving || managedBrowserInstalling}
                  onChange={event => {
                    browserChoiceDirtyRef.current = true
                    setBrowserChoice(event.target.value)
                    setError('')
                  }}
                >
                  <option value="system:">{copy.automaticBrowser}</option>
                  {(capability?.options || []).filter(option => option.kind !== 'managed-chromium').map(option => (
                    <option key={option.path} value={`system:${option.path}`}>
                      {browserKindName(option.kind)}
                    </option>
                  ))}
                  <option value="managed" disabled={!managedBrowserReady}>
                    {managedBrowserReady ? copy.managedBrowser : copy.managedBrowserNotInstalled}
                  </option>
                  <option value="external-cdp">{copy.externalBrowser}</option>
                </select>
              </label>
              {browserChoice === 'external-cdp' ? (
                <label className="code-plugin-browser-cdp">
                  <span>{copy.externalCdpAddress}</span>
                  <input
                    type="url"
                    value={externalCdpUrl}
                    placeholder={copy.externalCdpPlaceholder}
                    disabled={saving || managedBrowserInstalling}
                    onChange={event => {
                      browserChoiceDirtyRef.current = true
                      setExternalCdpUrl(event.target.value)
                      setError('')
                    }}
                  />
                </label>
              ) : null}
              <button
                type="button"
                className="code-plugin-browser-apply"
                disabled={saving || managedBrowserInstalling || !browserChoiceDirty}
                onClick={() => void saveBrowserChoice()}
              >
                {copy.applyBrowser}
              </button>
              {showManagedBrowserInstall ? (
                <button
                  type="button"
                  className="code-plugin-browser-install"
                  disabled={managedBrowserInstalling}
                  onClick={() => void installManagedBrowser()}
                >
                  {managedBrowserInstalling
                    ? copy.installingManagedBrowser
                    : installation?.updateAvailable
                      ? copy.updateManagedBrowser
                      : copy.installManagedBrowser}
                </button>
              ) : null}
            </div>
            <small>
              {browserReady ? browserSource(capability, copy) : copy.unavailableHint}
              {' · '}
              {copy.browserChangeHint}
            </small>
            {showManagedBrowserInstall ? <small>{copy.managedBrowserInstallHint}</small> : null}
            {(error || installation?.error) && (
              <div className="code-plugin-error" role="alert">{error || installation?.error}</div>
            )}
          </div>
          <button
            type="button"
            className={`code-plugin-toggle ${enabled ? 'active' : ''}`}
            aria-pressed={enabled}
            disabled={saving || managedBrowserInstalling || (!browserReady && !enabled)}
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
          const kindGroups = agentExtensionKindGroups(agent)
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
              ) : kindGroups.map(group => (
                <details
                  open
                  className="code-plugin-kind-section"
                  data-kind={group.kind}
                  key={group.kind}
                >
                  <summary>
                    <strong>{extensionKindLabel(group.kind, copy)}</strong>
                    <span>{copy.count(group.extensions.length)}</span>
                  </summary>
                  <div className="code-plugin-extension-list">
                    {group.extensions.map(extension => (
                      <button
                        type="button"
                        className="code-plugin-extension"
                        key={`${extension.homeId}:${extension.id}`}
                        onClick={() => setSelectedExtension({
                          ...extension,
                          agentName: agentDisplayName(agent),
                        })}
                      >
                        <div className="code-plugin-extension-title">
                          <strong>{extension.name}</strong>
                          <span>{extensionKindLabel(extension.kind, copy)}</span>
                        </div>
                        <div className="code-plugin-extension-meta">
                          <code>{extension.command}</code>
                          {extension.scope ? <span>{extension.scope}</span> : null}
                          {agent.homes.length > 1 || extension.homeId !== 'default' ? (
                            <span>{copy.home}: {extension.homeId}</span>
                          ) : null}
                        </div>
                        <p>{extension.description}</p>
                      </button>
                    ))}
                  </div>
                </details>
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
            onKeyDown={event => {
              if (event.key !== 'Escape') return
              event.stopPropagation()
              setSelectedExtension(null)
            }}
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
              <span>{extensionKindLabel(selectedExtension.kind, copy)}</span>
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
