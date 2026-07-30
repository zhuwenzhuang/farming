import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { appPath } from '@/lib/base-path'
import { getBackendConnectionSnapshot } from '@/lib/backend-live-status'
import { ArrowLeftGlyph, CloseGlyph, PlusGlyph, PuzzleGlyph } from '@/components/IconGlyphs'
import type { UiLanguage } from '@/lib/ui-preferences'
import type { BrowserCapability } from '../../../extensions/browser/frontend/types'
import type { ComputerCapability } from '../../../extensions/computer/frontend/types'
import type { CodexModelOption } from './types'

type NewAgentDefaults = {
  model: string
  reasoning: string
  fast: 'inherit' | 'on' | 'off'
}

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
  available: boolean
  discoverySupported: boolean
  homes: Array<{
    id: string
    path: string
    order: number
    newAgentDefaults: NewAgentDefaults
    extensions: AgentExtension[]
  }>
}

type AgentHomeDraft = {
  provider: string
  id: string
  path: string
}

type AgentConfiguration = {
  provider: AgentExtensionGroup
  home: AgentExtensionGroup['homes'][number]
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
    addAgent: zh ? '添加 Agent' : 'Add Agent',
    edit: zh ? '编辑' : 'Edit',
    remove: zh ? '删除' : 'Remove',
    save: zh ? '保存' : 'Save',
    cancel: zh ? '取消' : 'Cancel',
    moveUp: zh ? '上移' : 'Move up',
    moveDown: zh ? '下移' : 'Move down',
    dragToReorder: zh ? '拖动调整 Agent 顺序' : 'Drag to reorder Agents',
    unavailableAgent: zh ? '未安装' : 'Not installed',
    newAgentDefaults: zh ? '新 Agent 默认设置' : 'New Agent defaults',
    model: zh ? '模型' : 'Model',
    reasoning: zh ? '推理强度' : 'Reasoning',
    fast: 'Fast',
    inheritAgentConfig: zh ? '继承 Agent 配置' : 'Inherit Agent config',
    fastOn: zh ? '开启' : 'On',
    fastOff: zh ? '关闭' : 'Off',
    unsupportedDefault: zh ? '由 Agent 管理' : 'Managed by Agent',
    agentProvider: zh ? 'Agent 类型' : 'Agent provider',
    homeName: zh ? 'Home 名称' : 'Home name',
    homePath: zh ? 'Home 路径' : 'Home path',
    homeNamePlaceholder: zh ? '例如 work' : 'e.g. work',
    homePathPlaceholder: '~/.codex-work',
    invalidHome: zh ? '请输入有效且不重复的 Home 名称和路径。' : 'Enter a valid, unique Home name and path.',
    saveAgentFailed: zh ? 'Agent 设置保存失败' : 'Failed to save Agent settings',
    confirmRemoveAgent: (name: string) => zh ? `删除 ${name}？` : `Remove ${name}?`,
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
    isolatedBrowser: zh ? '隔离浏览器（Docker）' : 'Isolated Browser (Docker)',
    browserChoice: zh ? '浏览器来源' : 'Browser source',
    automaticBrowser: zh ? '自动（优先本机，否则隔离浏览器）' : 'Automatic (local first, then isolated)',
    applyBrowser: zh ? '应用' : 'Apply',
    prepareIsolatedBrowser: zh ? '准备隔离浏览器' : 'Prepare isolated Browser',
    preparingIsolatedBrowser: zh ? '正在下载并验证…' : 'Downloading and verifying…',
    isolatedBrowserHint: zh
      ? '显式下载固定版本的上游 CUA Browser 镜像（约 2 GB）；之后由 Farming 自动管理容器和 CDP，不需要配置端口。'
      : 'Explicitly downloads the pinned upstream CUA Browser image (about 2 GB); Farming then manages its container and CDP without port configuration.',
    isolatedBrowserPrepareFailed: zh ? '隔离浏览器准备失败' : 'Failed to prepare isolated Browser',
    isolatedCompatibilityRequired: zh
      ? '这台旧版 Docker 需要显式启用兼容模式后再重试。'
      : 'This older Docker Engine requires compatibility mode before retrying.',
    browserChangeHint: zh
      ? '切换后，正在运行的浏览器会停止。'
      : 'Changing this stops running Browsers.',
    unavailableHint: zh
      ? '可以选择本机 Chromium，或准备由 Farming 管理的隔离浏览器。'
      : 'Choose a local Chromium browser or prepare the Farming-managed isolated Browser.',
    enable: zh ? '启用' : 'Enable',
    disable: zh ? '停用' : 'Disable',
    saveFailed: zh ? '浏览器插件设置保存失败' : 'Failed to save Browser plugin settings',
    computer: zh ? '电脑' : 'Computer',
    computerDescription: zh
      ? '让 Agent 在隔离的 Linux 桌面中操作应用，并在 Farming 中观察或接管同一个桌面。'
      : 'Let Agents operate an isolated Linux desktop that you can observe or take over in Farming.',
    dockerUnavailable: zh ? '未检测到 Docker' : 'Docker not available',
    computerRuntimeReady: zh ? '运行时已准备' : 'Runtime ready',
    computerRuntimeMissing: zh ? '运行时未准备' : 'Runtime not prepared',
    prepareComputer: zh ? '准备运行时' : 'Prepare runtime',
    preparingComputer: zh ? '正在下载并验证…' : 'Downloading and verifying…',
    computerRuntimeHint: zh
      ? '显式下载固定版本的上游 CUA XFCE 镜像（约 1.3 GB）；Farming 不维护自己的镜像。'
      : 'Explicitly downloads the pinned upstream CUA XFCE image (about 1.3 GB); Farming does not maintain its own image.',
    compatibilityMode: zh ? '旧版 Docker 兼容模式' : 'Legacy Docker compatibility mode',
    compatibilityHint: zh
      ? '仅在旧 Docker 的 seccomp 阻止 CUA 启动时启用；该模式会对隔离容器关闭 seccomp。'
      : 'Enable only when old Docker seccomp blocks CUA startup; this disables seccomp for the isolated container.',
    computerSaveFailed: zh ? '电脑插件设置保存失败' : 'Failed to save Computer plugin settings',
    computerPrepareFailed: zh ? 'Computer 运行时准备失败' : 'Failed to prepare Computer runtime',
  }
}

function browserSource(capability: BrowserCapability | null, copy: ReturnType<typeof pluginCopy>) {
  if (!capability?.browser) return ''
  return capability.browser.kind === 'isolated-computer' ? copy.isolatedBrowser : copy.systemBrowser
}

function browserKindName(kind: string) {
  if (kind === 'chrome') return 'Google Chrome'
  if (kind === 'brave') return 'Brave'
  if (kind === 'edge') return 'Microsoft Edge'
  if (kind === 'chromium') return 'Chromium'
  return 'Chromium'
}

function agentDisplayName(agent: Pick<AgentExtensionGroup, 'id' | 'name'>) {
  if (agent.id === 'codex') return 'Codex'
  if (agent.id === 'claude') return 'Claude Code'
  if (agent.id === 'opencode') return 'OpenCode'
  if (agent.id === 'qoder') return 'Qoder'
  if (agent.id === 'qwen') return 'Qwen Code'
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

function agentExtensionKindGroups(home: AgentExtensionGroup['homes'][number]) {
  const groups = new Map<string, AgentExtension[]>()
  home.extensions.forEach(extension => {
      const entries = groups.get(extension.kind) || []
      entries.push(extension)
      groups.set(extension.kind, entries)
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

function agentConfigurationKey(provider: string, homeId: string) {
  return `${provider}:${homeId}`
}

function orderedAgentConfigurations(groups: AgentExtensionGroup[]): AgentConfiguration[] {
  return groups
    .flatMap(provider => provider.homes.map(home => ({ provider, home })))
    .sort((left, right) => (
      left.home.order - right.home.order
      || left.provider.id.localeCompare(right.provider.id)
      || left.home.id.localeCompare(right.home.id)
    ))
}

function normalizeAgentExtensionGroups(rawGroups: AgentExtensionGroup[]) {
  let fallbackOrder = 0
  return rawGroups.map(provider => ({
    ...provider,
    available: provider.available !== false,
    homes: (provider.homes || []).map(home => ({
      ...home,
      path: String(home.path || ''),
      order: Number.isFinite(Number(home.order)) ? Number(home.order) : fallbackOrder++,
      newAgentDefaults: {
        model: String(home.newAgentDefaults?.model || 'inherit'),
        reasoning: String(home.newAgentDefaults?.reasoning || 'inherit'),
        fast: home.newAgentDefaults?.fast === 'on' || home.newAgentDefaults?.fast === 'off'
          ? home.newAgentDefaults.fast
          : 'inherit',
      } satisfies NewAgentDefaults,
      extensions: Array.isArray(home.extensions) ? home.extensions : [],
    })),
  }))
}

function settingsHomes(groups: AgentExtensionGroup[]) {
  return Object.fromEntries(groups.map(provider => [
    provider.id,
    provider.homes.map(home => ({
      id: home.id,
      path: home.path,
      order: home.order,
      newAgentDefaults: home.newAgentDefaults,
    })),
  ]))
}

function homeIdForPath(homePath: string) {
  const segments = homePath.trim().replace(/\/+$/, '').split('/').filter(Boolean)
  const segment = segments[segments.length - 1] || 'home'
  return segment
    .replace(/^\.+/, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, 64) || 'home'
}

function reasoningOptionsForModel(model: string, catalog: CodexModelOption[]) {
  const exact = catalog.find(option => option.value === model)
  const values = exact?.reasoningLevels?.map(option => ({
    value: option.value,
    label: option.label,
  })) || catalog.flatMap(option => option.reasoningLevels || []).map(option => ({
    value: option.value,
    label: option.label,
  }))
  return [...new Map(values.map(option => [option.value, option])).values()]
}

export function PluginsPanel({
  capability,
  loading,
  computerCapability,
  computerLoading,
  onPrepareComputer,
  language,
  onBack,
  onRefreshCapability,
}: {
  capability: BrowserCapability | null
  loading: boolean
  computerCapability: ComputerCapability | null
  computerLoading: boolean
  onPrepareComputer: () => Promise<ComputerCapability>
  language: UiLanguage
  onBack: () => void
  onRefreshCapability: () => void
}) {
  const copy = useMemo(() => pluginCopy(language), [language])
  const [enabled, setEnabled] = useState(capability?.enabled === true)
  const [computerEnabled, setComputerEnabled] = useState(computerCapability?.enabled === true)
  const [computerCompatibilityMode, setComputerCompatibilityMode] = useState(
    computerCapability?.compatibilityMode === true,
  )
  const [computerSaving, setComputerSaving] = useState(false)
  const [computerPreparing, setComputerPreparing] = useState(false)
  const [computerError, setComputerError] = useState('')
  const [saving, setSaving] = useState(false)
  const [preparingIsolatedBrowser, setPreparingIsolatedBrowser] = useState(false)
  const [isolatedCompatibilityRequired, setIsolatedCompatibilityRequired] = useState(false)
  const [error, setError] = useState('')
  const [browserChoice, setBrowserChoice] = useState('system:')
  const browserChoiceDirtyRef = useRef(false)
  const [agentGroups, setAgentGroups] = useState<AgentExtensionGroup[]>([])
  const [agentGroupsLoading, setAgentGroupsLoading] = useState(true)
  const [agentGroupsError, setAgentGroupsError] = useState('')
  const [agentSaving, setAgentSaving] = useState(false)
  const [agentDraft, setAgentDraft] = useState<AgentHomeDraft | null>(null)
  const [editingAgentKey, setEditingAgentKey] = useState('')
  const [editingHomePath, setEditingHomePath] = useState('')
  const [draggingAgentKey, setDraggingAgentKey] = useState('')
  const [codexModels, setCodexModels] = useState<CodexModelOption[]>([])
  const [claudeModels, setClaudeModels] = useState<CodexModelOption[]>([])
  const [claudeReasoning, setClaudeReasoning] = useState<Array<{ value: string; label: string }>>([])
  const [selectedExtension, setSelectedExtension] = useState<SelectedAgentExtension | null>(null)
  const agentGroupsRequestRef = useRef(0)

  useEffect(() => {
    if (!capability || browserChoiceDirtyRef.current) return
    setEnabled(capability.enabled)
    const selection = capability.selection
    setBrowserChoice(selection?.source === 'isolated'
      ? 'isolated'
      : `system:${selection?.executablePath || ''}`)
  }, [capability])

  useEffect(() => {
    if (!computerCapability) return
    setComputerEnabled(computerCapability.enabled)
    setComputerCompatibilityMode(computerCapability.compatibilityMode)
  }, [computerCapability])

  const loadAgentGroups = useCallback(async () => {
    const requestId = agentGroupsRequestRef.current + 1
    agentGroupsRequestRef.current = requestId
    setAgentGroupsLoading(true)
    setAgentGroupsError('')
    try {
      const response = await fetch(appPath('/api/agent-extensions'), {
        headers: { Accept: 'application/json' },
      })
      const data = await response.json().catch(() => ({})) as {
        agents?: AgentExtensionGroup[]
        error?: string
      }
      if (!response.ok) throw new Error(data.error || copy.agentExtensionsFailed)
      if (agentGroupsRequestRef.current !== requestId) return
      setAgentGroups(normalizeAgentExtensionGroups(Array.isArray(data.agents) ? data.agents : []))
    } catch (loadError) {
      if (agentGroupsRequestRef.current !== requestId) return
      if (!getBackendConnectionSnapshot().connected) return
      setAgentGroupsError(loadError instanceof Error ? loadError.message : copy.agentExtensionsFailed)
    } finally {
      if (agentGroupsRequestRef.current === requestId) setAgentGroupsLoading(false)
    }
  }, [copy.agentExtensionsFailed])

  useEffect(() => {
    const retryLoad = () => void loadAgentGroups()
    window.addEventListener('farming:backend-connected', retryLoad)
    void loadAgentGroups()
    return () => {
      agentGroupsRequestRef.current += 1
      window.removeEventListener('farming:backend-connected', retryLoad)
    }
  }, [loadAgentGroups])

  useEffect(() => {
    let cancelled = false
    void Promise.all([
      fetch(appPath('/api/codex/models'))
        .then(response => response.ok ? response.json() : {})
        .then((data: { catalog?: CodexModelOption[] }) => {
          if (!cancelled) setCodexModels(Array.isArray(data.catalog) ? data.catalog : [])
        }),
      fetch(appPath('/api/claude/settings'))
        .then(response => response.ok ? response.json() : {})
        .then((data: {
          settings?: {
            modelOptions?: CodexModelOption[]
            effortOptions?: Array<{ value: string; label?: string }>
          }
        }) => {
          if (cancelled) return
          setClaudeModels(Array.isArray(data.settings?.modelOptions) ? data.settings.modelOptions : [])
          setClaudeReasoning(Array.isArray(data.settings?.effortOptions)
            ? data.settings.effortOptions.map(option => ({
                value: option.value,
                label: option.label || option.value,
              }))
            : [])
        }),
    ]).catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  const saveAgentGroups = useCallback(async (nextGroups: AgentExtensionGroup[]) => {
    if (agentSaving) return false
    setAgentSaving(true)
    setAgentGroupsError('')
    try {
      const response = await fetch(appPath('/api/settings'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ agentHomes: settingsHomes(nextGroups) }),
      })
      const data = await response.json().catch(() => ({})) as { error?: string }
      if (!response.ok) throw new Error(data.error || copy.saveAgentFailed)
      setAgentGroups(nextGroups)
      window.dispatchEvent(new CustomEvent('farming-agent-homes-saved'))
      await loadAgentGroups()
      return true
    } catch (saveError) {
      setAgentGroupsError(saveError instanceof Error ? saveError.message : copy.saveAgentFailed)
      return false
    } finally {
      setAgentSaving(false)
    }
  }, [agentSaving, copy.saveAgentFailed, loadAgentGroups])

  const updateHome = useCallback((
    providerId: string,
    homeId: string,
    updater: (home: AgentExtensionGroup['homes'][number]) => AgentExtensionGroup['homes'][number],
  ) => agentGroups.map(provider => (
    provider.id === providerId
      ? {
          ...provider,
          homes: provider.homes.map(home => home.id === homeId ? updater(home) : home),
        }
      : provider
  )), [agentGroups])

  const saveHomeDefaults = useCallback((
    providerId: string,
    homeId: string,
    patch: Partial<NewAgentDefaults>,
  ) => {
    const nextGroups = updateHome(providerId, homeId, home => ({
      ...home,
      newAgentDefaults: { ...home.newAgentDefaults, ...patch },
    }))
    void saveAgentGroups(nextGroups)
  }, [saveAgentGroups, updateHome])

  const submitAgentDraft = useCallback(() => {
    if (!agentDraft || agentSaving) return
    const providerId = agentDraft.provider
    const provider = agentGroups.find(group => group.id === providerId)
    const homePath = agentDraft.path.trim()
    const homeId = (agentDraft.id.trim() || homeIdForPath(homePath)).slice(0, 64)
    if (
      !provider
      || !homePath
      || !/^[A-Za-z0-9._-]+$/.test(homeId)
      || provider.homes.some(home => home.id.toLowerCase() === homeId.toLowerCase())
    ) {
      setAgentGroupsError(copy.invalidHome)
      return
    }
    const nextOrder = orderedAgentConfigurations(agentGroups)
      .reduce((maximum, configuration) => Math.max(maximum, configuration.home.order), -1) + 1
    const nextGroups = agentGroups.map(group => group.id === providerId
      ? {
          ...group,
          homes: [...group.homes, {
            id: homeId,
            path: homePath,
            order: nextOrder,
            newAgentDefaults: {
              model: 'inherit',
              reasoning: 'inherit',
              fast: 'inherit',
            } satisfies NewAgentDefaults,
            extensions: [],
          }],
        }
      : group)
    void saveAgentGroups(nextGroups).then(saved => {
      if (saved) setAgentDraft(null)
    })
  }, [agentDraft, agentGroups, agentSaving, copy.invalidHome, saveAgentGroups])

  const saveEditedHomePath = useCallback((providerId: string, homeId: string) => {
    const nextPath = editingHomePath.trim()
    if (!nextPath) {
      setAgentGroupsError(copy.invalidHome)
      return
    }
    const nextGroups = updateHome(providerId, homeId, home => ({ ...home, path: nextPath }))
    void saveAgentGroups(nextGroups).then(saved => {
      if (saved) {
        setEditingAgentKey('')
        setEditingHomePath('')
      }
    })
  }, [copy.invalidHome, editingHomePath, saveAgentGroups, updateHome])

  const removeAgentConfiguration = useCallback((providerId: string, homeId: string) => {
    if (homeId === 'default' || agentSaving) return
    const label = `${agentDisplayName({ id: providerId, name: providerId })} · ${homeId}`
    if (!window.confirm(copy.confirmRemoveAgent(label))) return
    const nextGroups = agentGroups.map(provider => provider.id === providerId
      ? { ...provider, homes: provider.homes.filter(home => home.id !== homeId) }
      : provider)
    void saveAgentGroups(nextGroups)
  }, [agentGroups, agentSaving, copy, saveAgentGroups])

  const reorderAgentConfigurations = useCallback((sourceKey: string, targetKey: string) => {
    if (!sourceKey || sourceKey === targetKey || agentSaving) return
    const ordered = orderedAgentConfigurations(agentGroups)
    const sourceIndex = ordered.findIndex(configuration => (
      agentConfigurationKey(configuration.provider.id, configuration.home.id) === sourceKey
    ))
    const targetIndex = ordered.findIndex(configuration => (
      agentConfigurationKey(configuration.provider.id, configuration.home.id) === targetKey
    ))
    if (sourceIndex < 0 || targetIndex < 0) return
    const [source] = ordered.splice(sourceIndex, 1)
    if (!source) return
    ordered.splice(targetIndex, 0, source)
    const orderByKey = new Map(ordered.map((configuration, order) => [
      agentConfigurationKey(configuration.provider.id, configuration.home.id),
      order,
    ]))
    const nextGroups = agentGroups.map(provider => ({
      ...provider,
      homes: provider.homes.map(home => ({
        ...home,
        order: orderByKey.get(agentConfigurationKey(provider.id, home.id)) ?? home.order,
      })),
    }))
    void saveAgentGroups(nextGroups)
  }, [agentGroups, agentSaving, saveAgentGroups])

  const moveAgentConfiguration = useCallback((key: string, offset: -1 | 1) => {
    const ordered = orderedAgentConfigurations(agentGroups)
    const index = ordered.findIndex(configuration => (
      agentConfigurationKey(configuration.provider.id, configuration.home.id) === key
    ))
    const target = ordered[index + offset]
    if (index < 0 || !target) return
    reorderAgentConfigurations(
      key,
      agentConfigurationKey(target.provider.id, target.home.id),
    )
  }, [agentGroups, reorderAgentConfigurations])

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
    const source = browserChoice === 'isolated' ? 'isolated' : 'system'
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

  const prepareIsolatedBrowser = async () => {
    if (preparingIsolatedBrowser) return
    setPreparingIsolatedBrowser(true)
    setIsolatedCompatibilityRequired(false)
    setError('')
    try {
      const response = await fetch(appPath('/api/browsers/isolated/prepare'), {
        method: 'POST',
        headers: { Accept: 'application/json' },
      })
      const data = await response.json().catch(() => ({})) as {
        compatibilityRequired?: boolean
        error?: string
      }
      if (!response.ok) {
        setIsolatedCompatibilityRequired(data.compatibilityRequired === true)
        throw new Error(data.error || copy.isolatedBrowserPrepareFailed)
      }
      onRefreshCapability()
    } catch (prepareError) {
      setError(prepareError instanceof Error ? prepareError.message : copy.isolatedBrowserPrepareFailed)
      onRefreshCapability()
    } finally {
      setPreparingIsolatedBrowser(false)
    }
  }

  const saveComputerSettings = async (patch: {
    computerCompatibilityMode?: boolean
    computerExtensionEnabled?: boolean
  }) => {
    if (computerSaving) return
    setComputerSaving(true)
    setComputerError('')
    try {
      const response = await fetch(appPath('/api/settings'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(patch),
      })
      const data = await response.json().catch(() => ({})) as {
        error?: string
        settings?: {
          computerCompatibilityMode?: boolean
          computerExtensionEnabled?: boolean
        }
      }
      if (!response.ok) throw new Error(data.error || copy.computerSaveFailed)
      setComputerEnabled(data.settings?.computerExtensionEnabled === true)
      setComputerCompatibilityMode(data.settings?.computerCompatibilityMode === true)
      onRefreshCapability()
    } catch (caught) {
      setComputerError(caught instanceof Error ? caught.message : copy.computerSaveFailed)
    } finally {
      setComputerSaving(false)
    }
  }

  const prepareComputer = async () => {
    if (computerPreparing) return
    setComputerPreparing(true)
    setComputerError('')
    try {
      await onPrepareComputer()
      onRefreshCapability()
    } catch (caught) {
      setComputerError(caught instanceof Error ? caught.message : copy.computerPrepareFailed)
      onRefreshCapability()
    } finally {
      setComputerPreparing(false)
    }
  }

  const browserReady = Boolean(capability?.browser)
  const savedBrowserChoice = capability?.selection?.source === 'isolated'
    ? 'isolated'
    : `system:${capability?.selection?.executablePath || ''}`
  const browserChoiceDirty = browserChoice !== savedBrowserChoice
  const isolatedBrowserReady = capability?.isolated?.imageReady === true
  const showIsolatedBrowserPrepare = !isolatedBrowserReady
    && capability?.isolated?.dockerAvailable === true
    && (
      browserChoice === 'isolated'
      || (!browserReady && browserChoice === 'system:')
    )
  const status = loading && capability === null
    ? copy.checking
    : browserReady
      ? enabled ? copy.enabled : copy.disabled
      : copy.unavailable
  const computerStatus = computerLoading && computerCapability === null
    ? copy.checking
    : !computerCapability?.dockerAvailable
      ? copy.dockerUnavailable
      : computerCapability.imageReady
        ? computerEnabled ? copy.enabled : copy.disabled
        : copy.computerRuntimeMissing

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
                  disabled={saving || preparingIsolatedBrowser}
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
                  <option value="isolated">{copy.isolatedBrowser}</option>
                </select>
              </label>
              <button
                type="button"
                className="code-plugin-browser-apply"
                disabled={
                  saving
                  || preparingIsolatedBrowser
                  || !browserChoiceDirty
                  || (browserChoice === 'isolated' && !isolatedBrowserReady)
                }
                onClick={() => void saveBrowserChoice()}
              >
                {copy.applyBrowser}
              </button>
              {showIsolatedBrowserPrepare ? (
                <button
                  type="button"
                  className="code-plugin-browser-install"
                  disabled={preparingIsolatedBrowser}
                  onClick={() => void prepareIsolatedBrowser()}
                >
                  {preparingIsolatedBrowser
                    ? copy.preparingIsolatedBrowser
                    : copy.prepareIsolatedBrowser}
                </button>
              ) : null}
            </div>
            <small>
              {browserReady ? browserSource(capability, copy) : copy.unavailableHint}
              {' · '}
              {copy.browserChangeHint}
            </small>
            {showIsolatedBrowserPrepare ? <small>{copy.isolatedBrowserHint}</small> : null}
            {isolatedCompatibilityRequired ? (
              <div className="code-plugin-computer-settings">
                <small>{copy.isolatedCompatibilityRequired}</small>
                <label>
                  <input
                    type="checkbox"
                    checked={computerCompatibilityMode}
                    disabled={computerSaving || computerPreparing || computerEnabled}
                    onChange={event => {
                      const next = event.currentTarget.checked
                      setComputerCompatibilityMode(next)
                      void saveComputerSettings({ computerCompatibilityMode: next })
                    }}
                  />
                  <span>{copy.compatibilityMode}</span>
                </label>
                <small>{copy.compatibilityHint}</small>
              </div>
            ) : null}
            {(error || capability?.isolated?.error) && (
              <div className="code-plugin-error" role="alert">
                {error || capability?.isolated?.error}
              </div>
            )}
          </div>
          <button
            type="button"
            className={`code-plugin-toggle ${enabled ? 'active' : ''}`}
            aria-pressed={enabled}
            disabled={saving || preparingIsolatedBrowser || (!browserReady && !enabled)}
            onClick={() => void toggleBrowser()}
          >
            {enabled ? copy.disable : copy.enable}
          </button>
        </article>
        <article className="code-plugin-card" data-testid="code-plugin-computer">
          <span className="code-plugin-card-icon" aria-hidden="true">
            <PuzzleGlyph />
          </span>
          <div className="code-plugin-card-copy">
            <div className="code-plugin-card-title">
              <h3>{copy.computer}</h3>
              <span className={`code-plugin-status ${computerCapability?.imageReady && computerEnabled ? 'enabled' : ''}`}>
                {computerStatus}
              </span>
            </div>
            <p>{copy.computerDescription}</p>
            <div className="code-plugin-computer-settings">
              <label>
                <input
                  type="checkbox"
                  checked={computerCompatibilityMode}
                  disabled={computerSaving || computerPreparing || computerEnabled}
                  onChange={event => {
                    const next = event.currentTarget.checked
                    setComputerCompatibilityMode(next)
                    void saveComputerSettings({ computerCompatibilityMode: next })
                  }}
                />
                <span>{copy.compatibilityMode}</span>
              </label>
              <small>{copy.compatibilityHint}</small>
              {!computerCapability?.imageReady && (
                <button
                  type="button"
                  disabled={computerPreparing || computerSaving || !computerCapability?.dockerAvailable}
                  onClick={() => void prepareComputer()}
                >
                  {computerPreparing ? copy.preparingComputer : copy.prepareComputer}
                </button>
              )}
            </div>
            <small>{copy.computerRuntimeHint}</small>
            {(computerError || (!computerCapability?.dockerAvailable && computerCapability?.error)) && (
              <div className="code-plugin-error" role="alert">
                {computerError || computerCapability?.error}
              </div>
            )}
          </div>
          <button
            type="button"
            className={`code-plugin-toggle ${computerEnabled ? 'active' : ''}`}
            aria-pressed={computerEnabled}
            disabled={
              computerSaving
              || computerPreparing
              || (!computerCapability?.imageReady && !computerEnabled)
            }
            onClick={() => void saveComputerSettings({
              computerExtensionEnabled: !computerEnabled,
            })}
          >
            {computerEnabled ? copy.disable : copy.enable}
          </button>
        </article>
      </section>

      <div className="code-plugin-agent-sections" data-testid="code-plugin-agent-sections">
        <header className="code-plugin-agent-sections-header">
          <div>
            <h3>{copy.agentExtensions}</h3>
            <p>{copy.agentExtensionsDescription}</p>
          </div>
          <button
            type="button"
            className="code-plugin-agent-add"
            disabled={agentSaving || agentGroups.length === 0}
            onClick={() => {
              setAgentGroupsError('')
              setAgentDraft(current => current ? null : {
                provider: agentGroups.find(group => group.available)?.id || agentGroups[0]?.id || 'codex',
                id: '',
                path: '',
              })
            }}
          >
            <PlusGlyph />
            <span>{copy.addAgent}</span>
          </button>
        </header>
        {agentDraft ? (
          <div className="code-plugin-agent-form" data-testid="code-plugin-agent-form">
            <label>
              <span>{copy.agentProvider}</span>
              <select
                value={agentDraft.provider}
                disabled={agentSaving}
                onChange={event => setAgentDraft(current => current
                  ? { ...current, provider: event.target.value }
                  : current)}
              >
                {agentGroups.filter(group => group.available).map(group => (
                  <option key={group.id} value={group.id}>{agentDisplayName(group)}</option>
                ))}
              </select>
            </label>
            <label>
              <span>{copy.homePath}</span>
              <input
                type="text"
                value={agentDraft.path}
                placeholder={copy.homePathPlaceholder}
                disabled={agentSaving}
                onChange={event => setAgentDraft(current => current
                  ? { ...current, path: event.target.value }
                  : current)}
              />
            </label>
            <label>
              <span>{copy.homeName}</span>
              <input
                type="text"
                value={agentDraft.id}
                placeholder={copy.homeNamePlaceholder}
                disabled={agentSaving}
                onChange={event => setAgentDraft(current => current
                  ? { ...current, id: event.target.value }
                  : current)}
              />
            </label>
            <div className="code-plugin-agent-form-actions">
              <button type="button" disabled={agentSaving} onClick={() => setAgentDraft(null)}>
                {copy.cancel}
              </button>
              <button type="button" className="primary" disabled={agentSaving} onClick={submitAgentDraft}>
                {copy.save}
              </button>
            </div>
          </div>
        ) : null}
        {agentGroupsError ? <div className="code-plugin-error" role="alert">{agentGroupsError}</div> : null}
        {agentGroupsLoading ? (
          <p className="code-plugin-empty">{copy.loadingAgentExtensions}</p>
        ) : orderedAgentConfigurations(agentGroups).map((configuration, configurationIndex, configurations) => {
          const { provider, home } = configuration
          const key = agentConfigurationKey(provider.id, home.id)
          const extensionCount = home.extensions.length
          const kindGroups = agentExtensionKindGroups(home)
          const supportsManagedDefaults = provider.id === 'codex' || provider.id === 'claude'
          const modelCatalog = provider.id === 'codex' ? codexModels : claudeModels
          const reasoningCatalog = provider.id === 'codex'
            ? reasoningOptionsForModel(home.newAgentDefaults.model, codexModels)
            : claudeReasoning
          const modelOptions = home.newAgentDefaults.model !== 'inherit'
            && !modelCatalog.some(option => option.value === home.newAgentDefaults.model)
            ? [{
                value: home.newAgentDefaults.model,
                label: home.newAgentDefaults.model,
              }, ...modelCatalog]
            : modelCatalog
          const reasoningOptions = home.newAgentDefaults.reasoning !== 'inherit'
            && !reasoningCatalog.some(option => option.value === home.newAgentDefaults.reasoning)
            ? [{
                value: home.newAgentDefaults.reasoning,
                label: home.newAgentDefaults.reasoning,
              }, ...reasoningCatalog]
            : reasoningCatalog
          return (
            <section
              key={key}
              className={`code-plugin-section code-plugin-agent-section ${draggingAgentKey === key ? 'dragging' : ''}`}
              data-testid={`code-plugin-section-agent-${provider.id}-${home.id}`}
              draggable={!agentSaving}
              onDragStart={event => {
                setDraggingAgentKey(key)
                event.dataTransfer.effectAllowed = 'move'
                event.dataTransfer.setData('text/plain', key)
              }}
              onDragEnd={() => setDraggingAgentKey('')}
              onDragOver={event => {
                event.preventDefault()
                event.dataTransfer.dropEffect = 'move'
              }}
              onDrop={event => {
                event.preventDefault()
                const sourceKey = event.dataTransfer.getData('text/plain') || draggingAgentKey
                setDraggingAgentKey('')
                reorderAgentConfigurations(sourceKey, key)
              }}
            >
              <header className="code-plugin-section-header code-plugin-agent-header">
                <span className="code-plugin-agent-drag" aria-hidden="true" title={copy.dragToReorder}>⋮⋮</span>
                <div className="code-plugin-agent-identity">
                  <h3>
                    {agentDisplayName(provider)}
                    <span>{home.id}</span>
                    {!provider.available ? <em>{copy.unavailableAgent}</em> : null}
                  </h3>
                  {editingAgentKey === key ? (
                    <div className="code-plugin-agent-path-edit">
                      <input
                        autoFocus
                        type="text"
                        value={editingHomePath}
                        disabled={agentSaving}
                        onChange={event => setEditingHomePath(event.target.value)}
                        onKeyDown={event => {
                          if (event.key === 'Enter') saveEditedHomePath(provider.id, home.id)
                          if (event.key === 'Escape') setEditingAgentKey('')
                        }}
                      />
                      <button type="button" disabled={agentSaving} onClick={() => saveEditedHomePath(provider.id, home.id)}>
                        {copy.save}
                      </button>
                      <button type="button" disabled={agentSaving} onClick={() => setEditingAgentKey('')}>
                        {copy.cancel}
                      </button>
                    </div>
                  ) : (
                    <p>{provider.description || agentDisplayName(provider)} · <code>{home.path}</code></p>
                  )}
                </div>
                <div className="code-plugin-agent-actions">
                  <button
                    type="button"
                    disabled={agentSaving || configurationIndex === 0}
                    aria-label={copy.moveUp}
                    title={copy.moveUp}
                    onClick={() => moveAgentConfiguration(key, -1)}
                  >↑</button>
                  <button
                    type="button"
                    disabled={agentSaving || configurationIndex === configurations.length - 1}
                    aria-label={copy.moveDown}
                    title={copy.moveDown}
                    onClick={() => moveAgentConfiguration(key, 1)}
                  >↓</button>
                  <button
                    type="button"
                    disabled={agentSaving}
                    onClick={() => {
                      setEditingAgentKey(key)
                      setEditingHomePath(home.path)
                    }}
                  >{copy.edit}</button>
                  {home.id !== 'default' ? (
                    <button
                      type="button"
                      disabled={agentSaving}
                      onClick={() => removeAgentConfiguration(provider.id, home.id)}
                    >{copy.remove}</button>
                  ) : null}
                  <span>{copy.count(extensionCount)}</span>
                </div>
              </header>

              <div className="code-plugin-agent-defaults">
                <strong>{copy.newAgentDefaults}</strong>
                <label>
                  <span>{copy.model}</span>
                  <select
                    value={home.newAgentDefaults.model}
                    disabled={agentSaving || !supportsManagedDefaults}
                    onChange={event => saveHomeDefaults(provider.id, home.id, {
                      model: event.target.value,
                      reasoning: 'inherit',
                    })}
                  >
                    <option value="inherit">{supportsManagedDefaults ? copy.inheritAgentConfig : copy.unsupportedDefault}</option>
                    {modelOptions.map(option => (
                      <option key={option.value} value={option.value}>{option.displayName || option.label}</option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>{copy.reasoning}</span>
                  <select
                    value={home.newAgentDefaults.reasoning}
                    disabled={agentSaving || !supportsManagedDefaults}
                    onChange={event => saveHomeDefaults(provider.id, home.id, {
                      reasoning: event.target.value,
                    })}
                  >
                    <option value="inherit">{supportsManagedDefaults ? copy.inheritAgentConfig : copy.unsupportedDefault}</option>
                    {reasoningOptions.map(option => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>{copy.fast}</span>
                  <select
                    value={home.newAgentDefaults.fast}
                    disabled={agentSaving || provider.id !== 'codex'}
                    onChange={event => saveHomeDefaults(provider.id, home.id, {
                      fast: event.target.value as NewAgentDefaults['fast'],
                    })}
                  >
                    <option value="inherit">{provider.id === 'codex' ? copy.inheritAgentConfig : copy.unsupportedDefault}</option>
                    {provider.id === 'codex' ? <option value="on">{copy.fastOn}</option> : null}
                    {provider.id === 'codex' ? <option value="off">{copy.fastOff}</option> : null}
                  </select>
                </label>
              </div>

              {!provider.discoverySupported ? (
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
                        key={extension.id}
                        onClick={() => setSelectedExtension({
                          ...extension,
                          agentName: `${agentDisplayName(provider)} · ${home.id}`,
                          homeId: home.id,
                        })}
                      >
                        <div className="code-plugin-extension-title">
                          <strong>{extension.name}</strong>
                          <span>{extensionKindLabel(extension.kind, copy)}</span>
                        </div>
                        <div className="code-plugin-extension-meta">
                          <code>{extension.command}</code>
                          {extension.scope ? <span>{extension.scope}</span> : null}
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
