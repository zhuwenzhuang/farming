import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CheckGlyph, ChevronLeftGlyph, CloseGlyph, ColorModeGlyph, PlusGlyph } from '@/components/IconGlyphs'
import { appPath } from '@/lib/base-path'
import type { UiPreferences } from '@/lib/ui-preferences'
import type { AgentHomeSetting, AgentHomesSettings, GlobalSettings } from './types'
import type { AgentLaunchOption } from './agent-launch-options'

type DraftState = { provider: string; id: string; path: string } | null

type UpdateStatus = {
  method?: string
  runtime?: { platform?: string; arch?: string }
  current?: { releaseVersion?: string; packageVersion?: string; type?: string }
  latest?: {
    version?: string
    assetName?: string
    blockedReason?: string
    source?: string
  }
  selected?: {
    version?: string
    assetName?: string
    blockedReason?: string
  }
  versions?: Array<{
    version?: string
    assetName?: string
    assetSize?: number
    blockedReason?: string
    installable?: boolean
    available?: boolean
  }>
  available?: boolean
  installable?: boolean
  blockingAgents?: Array<{ id: string; command: string; task?: string; cwd?: string }>
  state?: { phase?: string; error?: string; version?: string; previousVersion?: string }
  checkedAt?: string
}

interface AgentHomesSettingsPanelProps {
  open: boolean
  activeAgentId?: string | null
  language: UiPreferences['language']
  uiPreferences: UiPreferences
  agentLaunchOptions: AgentLaunchOption[]
  onClose: () => void
  onUpdateUiPreferences: (preferences: Partial<UiPreferences>) => void
}

const KNOWN_PROVIDERS = ['codex', 'claude', 'opencode', 'qoder']
const NON_CODING_AGENT_NAMES = new Set(['bash', 'zsh'])
const ID_PATTERN = /^[A-Za-z0-9._-]+$/
const SEARCH_TIMEOUT_OPTIONS_SECONDS = [3, 5, 10, 15, 30, 60, 180]

function nearestSearchTimeoutSeconds(timeoutMs: number) {
  const seconds = timeoutMs / 1000
  return SEARCH_TIMEOUT_OPTIONS_SECONDS.reduce((closest, option) => (
    Math.abs(option - seconds) < Math.abs(closest - seconds) ? option : closest
  ))
}

function panelCopy(language: UiPreferences['language']) {
  const zh = language === 'zh'
  return {
    title: zh ? '设置' : 'Settings',
    subtitle: zh ? '管理 Farming 的本地元数据。' : 'Manage local Farming metadata.',
    close: zh ? '关闭' : 'Close',
    back: zh ? '返回导航' : 'Back to navigation',
    general: zh ? '通用' : 'General',
    appearance: zh ? '外观' : 'Appearance',
    light: zh ? '浅色' : 'Light',
    dark: zh ? '深色' : 'Dark',
    interface: zh ? '界面' : 'Interface',
    interfaceSkin: zh ? '界面皮肤' : 'Interface skin',
    farmingCode: 'Farming Code',
    farmingCrt: 'Farming CRT',
    language: zh ? '语言' : 'Language',
    english: 'English',
    chinese: '中文',
    search: zh ? '搜索' : 'Search',
    agentPermissions: zh ? 'Agent 权限' : 'Agent Permissions',
    dangerousSkipLabel: zh ? '默认跳过所有 agent 权限检查' : 'Skip all agent permission checks by default',
    dangerousSkipHint: zh
      ? '开启后，新启动的 Codex、Claude、OpenCode、Qoder、Qwen、Aider、GitHub Copilot CLI、Amazon Q 等会使用各自的危险跳过权限 flag。只在可信沙箱中使用。'
      : 'When enabled, new Codex, Claude, OpenCode, Qoder, Qwen, Aider, GitHub Copilot CLI, Amazon Q, and similar agents launch with their provider-specific dangerous skip flags. Use only in trusted sandboxes.',
    searchTimeout: zh ? '搜索超时' : 'Search timeout',
    searchTimeoutValue: (seconds: number) => zh
      ? (seconds >= 60 ? `${seconds / 60} 分钟` : `${seconds} 秒`)
      : (seconds >= 60 ? `${seconds / 60} min` : `${seconds} sec`),
    updates: zh ? '更新' : 'Updates',
    updateUrl: zh ? '更新 URL' : 'Update URL',
    updateUrlPlaceholder: 'https://github.com/zhuwenzhuang/farming/releases/latest',
    updateUrlEmpty: zh ? '等待检查更新' : 'Waiting for update check',
    saveUpdateUrl: zh ? '保存更新 URL' : 'Save Update URL',
    refreshUpdates: zh ? '刷新' : 'Refresh',
    updateAction: zh ? '更新' : 'Update',
    updateToVersion: (version: string) => zh ? `更新到 ${version}` : `Update to ${version}`,
    updating: zh ? '更新中…' : 'Updating…',
    checkingUpdates: zh ? '正在检查更新…' : 'Checking for updates…',
    currentVersion: zh ? '当前版本' : 'Current',
    latestVersion: zh ? '最新版本' : 'Latest',
    targetVersion: zh ? '升级版本' : 'Target',
    updateSource: zh ? '更新源' : 'Update source',
    updateMethodLabel: (method: string) => ({
      npm: 'npm',
      'app-bundle': zh ? '兼容包' : 'App bundle',
      'source-deploy': zh ? '源码部署' : 'Source deployment',
      source: zh ? '源码检出' : 'Source checkout',
      'standalone-cli': zh ? '单文件 CLI' : 'Standalone CLI',
    }[method] || method || '-'),
    upToDate: zh ? '已是最新版本' : 'Up to date',
    updateAvailable: zh ? '有新版本可用' : 'Update available',
    updateNotInstallable: zh ? '当前更新不可安装' : 'Update is not installable',
    updateInstalling: zh ? '升级已开始，服务会自动重启。' : 'Upgrade started. The server will restart automatically.',
    updateRestarting: zh ? '新版本已安装，正在重启 Farming。' : 'The new version is installed. Restarting Farming.',
    updateSucceeded: zh ? '更新成功。' : 'Update completed.',
    updateRolledBack: zh ? '新版本启动失败，已回退到旧版本。' : 'The new version failed to start and Farming rolled back.',
    agentHomes: 'Agent Homes',
    agentHomesHint: zh
      ? '为不同 Agent 配置独立的主目录。'
      : 'Configure a separate home directory for each agent.',
    addHome: (provider: string) => zh ? `添加 ${provider} home` : `Add ${provider} home`,
    edit: zh ? '编辑' : 'Edit',
    remove: zh ? '删除' : 'Remove',
    save: zh ? '保存' : 'Save',
    cancel: zh ? '取消' : 'Cancel',
    homeName: zh ? 'Home 名称（可选）' : 'Home name (optional)',
    homePath: zh ? 'Home 路径' : 'Home path',
    homeNameHint: zh ? '留空时将根据路径自动生成。允许字母、数字、点、下划线和短横线。' : 'Leave empty to generate it from the path. Use letters, numbers, dots, underscores, and hyphens.',
    homeNamePlaceholder: zh ? '例如：work' : 'e.g. work',
    pathPlaceholder: '~/.codex.local',
    loading: zh ? '加载中…' : 'Loading…',
    saving: zh ? '保存中…' : 'Saving…',
    saved: zh ? '已保存' : 'Saved',
    loadFailed: zh ? '加载设置失败' : 'Failed to load settings',
    saveFailed: zh ? '保存失败' : 'Failed to save',
    invalidId: zh ? 'Home 名称只能包含字母、数字、点、下划线和短横线。' : 'Home name can only contain letters, numbers, dots, underscores, and hyphens.',
    duplicateId: zh ? '同一个 provider 下 Home 名称不能重复。' : 'Home name must be unique under the same provider.',
    missingPath: zh ? 'Home 路径不能为空。' : 'Home path is required.',
    removeLastHint: zh ? '至少保留一个 home。' : 'Keep at least one home.',
    removeDefaultHint: zh ? 'default home 不能删除。' : 'The default home cannot be removed.',
    editDisabledHint: zh ? 'home 不支持编辑；请删除后重新添加。' : 'Homes cannot be edited. Remove and add again.',
    confirmRemove: (id: string) => zh ? `删除 home ${id}？` : `Remove home ${id}?`,
    empty: zh ? '还没有配置 home。' : 'No homes configured.',
    noAgents: zh ? '当前机器没有识别到可配置的 coding agent。' : 'No configurable coding agents were detected on this machine.',
    unavailable: zh ? '未安装' : 'Not installed',
  }
}

function normalizeProvider(provider: string) {
  return provider.trim().toLowerCase()
}

function normalizeHomes(raw: unknown): AgentHomesSettings {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {}
  const normalized: AgentHomesSettings = {}

  Object.entries(source).forEach(([rawProvider, rawHomes]) => {
    const provider = normalizeProvider(rawProvider)
    if (!provider || !/^[a-z0-9._-]+$/.test(provider) || !Array.isArray(rawHomes)) return
    const seen = new Set<string>()
    const homes: AgentHomeSetting[] = []
    rawHomes.forEach(rawHome => {
      if (!rawHome || typeof rawHome !== 'object') return
      const home = rawHome as Partial<AgentHomeSetting>
      const id = String(home.id ?? '').trim()
      const path = String(home.path ?? '').trim()
      if (!id || !path || !ID_PATTERN.test(id)) return
      const idKey = id.toLowerCase()
      if (seen.has(idKey)) return
      seen.add(idKey)
      homes.push({ id, path })
    })
    if (homes.length > 0) normalized[provider] = homes
  })


  return normalized
}

function providerDisplayName(provider: string) {
  if (provider === 'codex') return 'Codex'
  if (provider === 'claude') return 'Claude'
  if (provider === 'opencode') return 'OpenCode'
  if (provider === 'qoder') return 'Qoder'
  return provider
}

function defaultPathForProvider(provider: string) {
  const defaultPaths: Record<string, string> = {
    codex: '~/.codex',
    claude: '~/.claude',
    opencode: '~/.opencode',
    qoder: '~/.qoder',
  }
  return defaultPaths[provider] ?? `~/.${provider}`
}

function hasNonDefaultHomes(homes: AgentHomeSetting[] | undefined) {
  return Boolean(homes?.some(home => home.id.toLowerCase() !== 'default'))
}

function availableCodingProviders(agentLaunchOptions: AgentLaunchOption[]) {
  return agentLaunchOptions
    .filter(option => option.supported !== false && option.interactive !== false)
    .filter(option => !NON_CODING_AGENT_NAMES.has(option.name))
    .filter(option => KNOWN_PROVIDERS.includes(option.name))
    .map(option => normalizeProvider(option.name))
    .filter(Boolean)
}

function orderedProviders(homes: AgentHomesSettings, agentLaunchOptions: AgentLaunchOption[]) {
  const available = new Set(availableCodingProviders(agentLaunchOptions))
  const configuredWithCustomHomes = Object.keys(homes).filter(provider => hasNonDefaultHomes(homes[provider]))
  const keys = new Set([...available, ...configuredWithCustomHomes])
  return Array.from(keys).sort((left, right) => {
    const leftRank = KNOWN_PROVIDERS.indexOf(left)
    const rightRank = KNOWN_PROVIDERS.indexOf(right)
    const normalizedLeftRank = leftRank === -1 ? KNOWN_PROVIDERS.length : leftRank
    const normalizedRightRank = rightRank === -1 ? KNOWN_PROVIDERS.length : rightRank
    if (normalizedLeftRank !== normalizedRightRank) return normalizedLeftRank - normalizedRightRank
    return left.localeCompare(right)
  })
}

function homesForProvider(homes: AgentHomesSettings, provider: string) {
  const current = homes[provider] ?? []
  if (current.some(home => home.id.toLowerCase() === 'default')) return current
  return [{ id: 'default', path: defaultPathForProvider(provider) }, ...current]
}


function homeNameForPath(homePath: string, homes: AgentHomeSetting[]) {
  const pathSegments = homePath.trim().replace(/\/+$/, '').split('/').filter(Boolean)
  const pathSegment = pathSegments[pathSegments.length - 1] ?? ''
  const baseName = pathSegment
    .replace(/^\.+/, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, 64) || 'home'
  const existingIds = new Set(homes.map(home => home.id.toLowerCase()))
  let suffix = 1
  let id = baseName
  while (existingIds.has(id.toLowerCase())) {
    suffix += 1
    id = `${baseName}-${suffix}`
  }
  return {
    id,
  }
}

function nextHomeDraft(provider: string) {
  return { provider, id: '', path: '' }
}

export function AgentHomesSettingsPanel({
  open,
  activeAgentId = null,
  language,
  uiPreferences,
  agentLaunchOptions,
  onClose,
  onUpdateUiPreferences,
}: AgentHomesSettingsPanelProps) {
  const copy = useMemo(() => panelCopy(language), [language])
  const closeButtonRef = useRef<HTMLButtonElement | null>(null)
  const searchTimeoutSaveTimerRef = useRef<number | null>(null)
  const upgradeTargetVersionRef = useRef('')
  const [dangerouslySkipPermissions, setDangerouslySkipPermissions] = useState(false)
  const [updateUrl, setUpdateUrl] = useState('')
  const [searchTimeoutSeconds, setSearchTimeoutSeconds] = useState(15)
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null)
  const [selectedUpdateAsset, setSelectedUpdateAsset] = useState('')
  const [updateChecking, setUpdateChecking] = useState(false)
  const [updateSaving, setUpdateSaving] = useState(false)
  const [homes, setHomes] = useState<AgentHomesSettings>(() => normalizeHomes({
    codex: [{ id: 'default', path: '~/.codex' }],
    claude: [{ id: 'default', path: '~/.claude' }],
    opencode: [{ id: 'default', path: '~/.opencode' }],
    qoder: [{ id: 'default', path: '~/.qoder' }],
  }))
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [draft, setDraft] = useState<DraftState>(null)

  const loadSettings = useCallback(() => {
    setLoading(true)
    setError('')
    fetch(appPath('/api/settings'))
      .then(response => response.json())
      .then((data: { settings?: GlobalSettings }) => {
        setHomes(normalizeHomes(data.settings?.agentHomes))
        setDangerouslySkipPermissions(data.settings?.dangerouslySkipAgentPermissionsByDefault === true)
        setUpdateUrl(String(data.settings?.updateUrl ?? ''))
        setSearchTimeoutSeconds(nearestSearchTimeoutSeconds(Number(data.settings?.searchTimeoutMs ?? 15000)))
      })
      .catch(() => setError(copy.loadFailed))
      .finally(() => setLoading(false))
  }, [copy.loadFailed])

  useEffect(() => () => {
    if (searchTimeoutSaveTimerRef.current !== null) window.clearTimeout(searchTimeoutSaveTimerRef.current)
  }, [])

  useEffect(() => {
    if (!open) return
    loadSettings()
    window.requestAnimationFrame(() => closeButtonRef.current?.focus({ preventScroll: true }))
  }, [loadSettings, open])

  useEffect(() => {
    if (!open) return undefined
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose, open])

  const saveHomes = useCallback((nextHomes: AgentHomesSettings) => {
    setSaving(true)
    setError('')
    setNotice('')
    fetch(appPath('/api/settings'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentHomes: nextHomes }),
    })
      .then(async response => {
        const data = await response.json().catch(() => null) as { settings?: GlobalSettings; error?: string } | null
        if (!response.ok) throw new Error(data?.error || copy.saveFailed)
        const normalized = normalizeHomes(data?.settings?.agentHomes ?? nextHomes)
        setHomes(normalized)
        setDraft(null)
        setNotice(copy.saved)
        window.dispatchEvent(new CustomEvent('farming-agent-homes-saved'))
      })
      .catch(error => setError(error instanceof Error ? error.message : copy.saveFailed))
      .finally(() => setSaving(false))
  }, [copy.saveFailed, copy.saved])

  const refreshUpdateStatus = useCallback((force = true, quiet = false) => {
    if (!quiet) {
      setUpdateChecking(true)
      setError('')
    }
    fetch(appPath(`/api/update${force ? '?force=1' : ''}`))
      .then(async response => {
        const data = await response.json().catch(() => null) as { update?: UpdateStatus; error?: string } | null
        if (!response.ok) throw new Error(data?.error || copy.loadFailed)
        const nextUpdate = data?.update ?? null
        setUpdateStatus(nextUpdate)
        const versions = nextUpdate?.versions ?? []
        setSelectedUpdateAsset(current => {
          if (current && versions.some(version => version.assetName === current)) return current
          return versions[0]?.assetName || ''
        })
      })
      .catch(error => {
        if (!quiet) setError(error instanceof Error ? error.message : copy.loadFailed)
      })
      .finally(() => {
        if (!quiet) setUpdateChecking(false)
      })
  }, [copy.loadFailed])

  const saveUpdateUrl = useCallback(() => {
    setUpdateSaving(true)
    setError('')
    setNotice('')
    fetch(appPath('/api/settings'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ updateUrl }),
    })
      .then(async response => {
        const data = await response.json().catch(() => null) as { settings?: GlobalSettings; error?: string } | null
        if (!response.ok) throw new Error(data?.error || copy.saveFailed)
        setUpdateUrl(String(data?.settings?.updateUrl ?? ''))
        setNotice(copy.saved)
        refreshUpdateStatus(true)
      })
      .catch(error => setError(error instanceof Error ? error.message : copy.saveFailed))
      .finally(() => setUpdateSaving(false))
  }, [copy.saveFailed, copy.saved, refreshUpdateStatus, updateUrl])

  const setSearchTimeout = useCallback((seconds: number) => {
    setSearchTimeoutSeconds(seconds)
    setError('')
    if (searchTimeoutSaveTimerRef.current !== null) window.clearTimeout(searchTimeoutSaveTimerRef.current)
    searchTimeoutSaveTimerRef.current = window.setTimeout(() => {
      fetch(appPath('/api/settings'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ searchTimeoutMs: seconds * 1000 }),
      })
        .then(async response => {
          const data = await response.json().catch(() => null) as { settings?: GlobalSettings; error?: string } | null
          if (!response.ok) throw new Error(data?.error || copy.saveFailed)
          setSearchTimeoutSeconds(nearestSearchTimeoutSeconds(Number(data?.settings?.searchTimeoutMs ?? seconds * 1000)))
        })
        .catch(error => setError(error instanceof Error ? error.message : copy.saveFailed))
    }, 120)
  }, [copy.saveFailed])

  const startUpgrade = useCallback(() => {
    const selectedVersion = updateStatus?.versions?.find(version => version.assetName === selectedUpdateAsset)
    if (!selectedVersion?.available) {
      refreshUpdateStatus(true)
      return
    }

    setUpdateChecking(true)
    setError('')
    setNotice('')
    upgradeTargetVersionRef.current = selectedVersion.version || selectedVersion.assetName || ''
    fetch(appPath('/api/update/install'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assetName: selectedUpdateAsset }),
    })
      .then(async response => {
        const data = await response.json().catch(() => null) as { update?: { state?: UpdateStatus['state']; blockingAgents?: UpdateStatus['blockingAgents'] }; error?: string; blockingAgents?: UpdateStatus['blockingAgents'] } | null
        if (!response.ok) {
          const blockers = data?.blockingAgents || []
          const suffix = blockers.length ? `: ${blockers.map(agent => agent.command).join(', ')}` : ''
          throw new Error(`${data?.error || copy.saveFailed}${suffix}`)
        }
        setUpdateStatus(current => ({
          ...(current ?? {}),
          state: data?.update?.state ?? current?.state,
          blockingAgents: data?.update?.blockingAgents ?? current?.blockingAgents,
        }))
      })
      .catch(error => {
        upgradeTargetVersionRef.current = ''
        setError(error instanceof Error ? error.message : copy.saveFailed)
      })
      .finally(() => setUpdateChecking(false))
  }, [copy, refreshUpdateStatus, selectedUpdateAsset, updateStatus])

  useEffect(() => {
    if (!open) return
    refreshUpdateStatus(false)
  }, [open, refreshUpdateStatus])

  const saveDangerouslySkipPermissions = useCallback((enabled: boolean) => {
    setDangerouslySkipPermissions(enabled)
    setSaving(true)
    setError('')
    setNotice('')
    fetch(appPath('/api/settings'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dangerouslySkipAgentPermissionsByDefault: enabled }),
    })
      .then(async response => {
        const data = await response.json().catch(() => null) as { settings?: GlobalSettings; error?: string } | null
        if (!response.ok) throw new Error(data?.error || copy.saveFailed)
        setDangerouslySkipPermissions(data?.settings?.dangerouslySkipAgentPermissionsByDefault === true)
        setNotice(copy.saved)
      })
      .catch(error => {
        setDangerouslySkipPermissions(!enabled)
        setError(error instanceof Error ? error.message : copy.saveFailed)
      })
      .finally(() => setSaving(false))
  }, [copy.saveFailed, copy.saved])

  const submitDraft = useCallback(() => {
    if (!draft) return
    const provider = normalizeProvider(draft.provider)
    const homePath = draft.path.trim()
    if (!homePath) {
      setError(copy.missingPath)
      return
    }
    const current = homes[provider] ?? []
    const id = draft.id.trim() || homeNameForPath(homePath, current).id
    if (!ID_PATTERN.test(id)) {
      setError(copy.invalidId)
      return
    }
    const duplicate = current.some(home => home.id.toLowerCase() === id.toLowerCase())
    if (duplicate) {
      setError(copy.duplicateId)
      return
    }
    saveHomes({ ...homes, [provider]: [...current, { id, path: homePath }] })
  }, [copy.duplicateId, copy.invalidId, copy.missingPath, draft, homes, saveHomes])

  const removeHome = useCallback((provider: string, id: string) => {
    if (id.toLowerCase() === 'default') return
    const current = homes[provider] ?? []
    if (!window.confirm(copy.confirmRemove(id))) return
    saveHomes({
      ...homes,
      [provider]: current.filter(home => home.id !== id),
    })
  }, [copy, homes, saveHomes])

  const updatePhase = updateStatus?.state?.phase || ''
  useEffect(() => {
    if (!open || !['downloading', 'extracting', 'installing', 'restarting', 'rolling-back'].includes(updatePhase)) return
    const timer = window.setInterval(() => refreshUpdateStatus(false, true), 1500)
    return () => window.clearInterval(timer)
  }, [open, refreshUpdateStatus, updatePhase])

  useEffect(() => {
    if (!open || updatePhase !== 'succeeded' || !upgradeTargetVersionRef.current) return undefined
    const installedVersion = updateStatus?.state?.version
      || updateStatus?.current?.releaseVersion
      || updateStatus?.current?.packageVersion
      || ''
    if (installedVersion !== upgradeTargetVersionRef.current) return undefined
    upgradeTargetVersionRef.current = ''
    window.location.reload()
    return undefined
  }, [open, updatePhase, updateStatus])

  if (!open) return null

  const providers = orderedProviders(homes, agentLaunchOptions)
  const updateVersions = updateStatus?.versions ?? []
  const selectedVersion = updateVersions.find(version => version.assetName === selectedUpdateAsset)
  const updateInstallBusy = ['downloading', 'extracting', 'installing', 'restarting', 'rolling-back'].includes(updatePhase)
  const updateBusy = updateChecking || updateSaving || updateInstallBusy
  const updateMethod = updateStatus?.method || updateStatus?.current?.type || ''
  const updateMethodLabel = copy.updateMethodLabel(updateMethod)
  const bundleUpdate = updateMethod === 'app-bundle' || updateMethod === 'source-deploy'
  const currentUpdateVersion = updateStatus?.current?.releaseVersion
    || updateStatus?.current?.packageVersion
    || updateStatus?.state?.previousVersion
    || '-'
  const latestUpdateVersion = updateStatus?.latest?.version || '-'
  const targetUpdateVersion = selectedVersion?.version || updateStatus?.selected?.version || latestUpdateVersion
  const showUpdateTransition = currentUpdateVersion !== '-'
    && targetUpdateVersion !== '-'
    && currentUpdateVersion !== targetUpdateVersion
    && (updateStatus?.available === true || updateBusy)
  const updateSummary = !updateStatus
    ? copy.checkingUpdates
    : updatePhase === 'rolled-back'
      ? copy.updateRolledBack
      : updatePhase === 'failed' && updateStatus?.state?.error
        ? updateStatus.state.error
        : updatePhase === 'restarting'
          ? copy.updateRestarting
          : ['downloading', 'extracting', 'installing', 'rolling-back'].includes(updatePhase)
            ? copy.updateInstalling
            : updateStatus.available
              ? copy.updateAvailable
              : updatePhase === 'succeeded'
                ? copy.updateSucceeded
                : updateStatus.latest?.blockedReason || copy.upToDate
  const updateActionLabel = updateInstallBusy
    ? copy.updating
    : selectedVersion?.available && targetUpdateVersion !== '-'
      ? copy.updateToVersion(targetUpdateVersion)
      : copy.updateAction
  return (
    <div className="code-settings-panel-overlay" data-testid="code-settings-panel" onPointerDown={event => {
      if (event.target === event.currentTarget) onClose()
    }}>
      <aside className="code-settings-panel" aria-modal="true" role="dialog" aria-labelledby="code-settings-panel-title">
        <header className="code-settings-panel-header">
          <button type="button" className="code-settings-panel-back" onClick={onClose} aria-label={copy.back}><ChevronLeftGlyph /></button>
          <div>
            <h2 id="code-settings-panel-title">{copy.title}</h2>
          </div>
          <button ref={closeButtonRef} type="button" className="code-settings-panel-close" onClick={onClose} aria-label={copy.close}><CloseGlyph /></button>
        </header>

        <div className="code-settings-panel-body">
          <section className="code-settings-section compact">
            <div className="code-settings-inline-preferences">
              <div className="code-settings-inline-choice">
                <ColorModeGlyph aria-hidden="true" />
                <div className="code-settings-segmented" role="group" aria-label={copy.appearance}>
                  <button type="button" className={uiPreferences.appearance === 'light' ? 'active' : ''} onClick={() => onUpdateUiPreferences({ appearance: 'light' })}>{copy.light}</button>
                  <button type="button" className={uiPreferences.appearance === 'dark' ? 'active' : ''} onClick={() => onUpdateUiPreferences({ appearance: 'dark' })}>{copy.dark}</button>
                </div>
              </div>
              <div className="code-settings-inline-choice code-settings-language-choice">
                <div className="code-settings-segmented" role="group" aria-label={copy.language}>
                  <button type="button" className={uiPreferences.language === 'en' ? 'active' : ''} onClick={() => onUpdateUiPreferences({ language: 'en' })}>{copy.english}</button>
                  <button type="button" className={uiPreferences.language === 'zh' ? 'active' : ''} onClick={() => onUpdateUiPreferences({ language: 'zh' })}>{copy.chinese}</button>
                </div>
              </div>
            </div>
          </section>

          <section className="code-settings-section code-settings-group">
            <div className="code-settings-section-heading">
              <div><h3>{copy.interface}</h3></div>
            </div>
            <div className="code-settings-card">
              <div className="code-settings-choice-row code-settings-runtime-row">
                <div className="code-settings-row-copy">
                  <strong>{copy.interfaceSkin}</strong>
                </div>
                <div className="code-settings-segmented" role="group" aria-label={copy.interfaceSkin}>
                  <button
                    type="button"
                    className="active"
                    data-testid="code-settings-skin-code"
                    aria-pressed="true"
                  >{copy.farmingCode}</button>
                  <button
                    type="button"
                    data-testid="code-settings-skin-crt"
                    aria-pressed="false"
                    onClick={() => window.location.assign(
                      `${appPath('/crt/')}${activeAgentId ? `?agent=${encodeURIComponent(activeAgentId)}` : ''}`,
                    )}
                  >{copy.farmingCrt}</button>
                </div>
              </div>
            </div>
          </section>

          <section className="code-settings-section code-settings-group">
            <div className="code-settings-section-heading">
              <div><h3>{copy.search}</h3></div>
            </div>
            <div className="code-settings-card">
              <div className="code-settings-choice-row code-settings-search-timeout-row">
                <div className="code-settings-row-copy">
                  <strong>{copy.searchTimeout}</strong>
                </div>
                <input
                  type="range"
                  min="0"
                  max={String(SEARCH_TIMEOUT_OPTIONS_SECONDS.length - 1)}
                  step="1"
                  value={SEARCH_TIMEOUT_OPTIONS_SECONDS.indexOf(searchTimeoutSeconds)}
                  aria-label={copy.searchTimeout}
                  onChange={event => setSearchTimeout(SEARCH_TIMEOUT_OPTIONS_SECONDS[Number(event.target.value)] ?? 15)}
                />
                <output>{copy.searchTimeoutValue(searchTimeoutSeconds)}</output>
              </div>
            </div>
          </section>

          <section className="code-settings-section">
            <div className="code-settings-section-heading">
              <div>
                <h3>{copy.updates}</h3>
              </div>
            </div>
            <div className={`code-settings-update-card ${updateStatus?.available ? 'available' : ''}`} data-testid="code-settings-update-card">
              <div className="code-settings-update-overview">
                <div className="code-settings-update-versions" aria-label={`${copy.currentVersion} ${currentUpdateVersion}; ${copy.latestVersion} ${latestUpdateVersion}`}>
                  <span>{currentUpdateVersion}</span>
                  {showUpdateTransition && <>
                    <span className="code-settings-update-arrow" aria-hidden="true">→</span>
                    <strong>{targetUpdateVersion}</strong>
                  </>}
                </div>
                <div
                  className={`code-settings-update-summary ${updateStatus?.available ? 'available' : ''} ${updatePhase ? `phase-${updatePhase}` : ''}`}
                  role="status"
                  aria-live="polite"
                >
                  {updateMethod && <><span>{updateMethodLabel}</span><span aria-hidden="true"> · </span></>}
                  <span>{updateSummary}</span>
                </div>
              </div>
              <div className="code-settings-update-actions">
                <button
                  type="button"
                  className="code-settings-update-refresh"
                  onClick={() => refreshUpdateStatus(true)}
                  disabled={updateBusy}
                  aria-label={copy.refreshUpdates}
                  title={copy.refreshUpdates}
                >↻</button>
                <button
                  type="button"
                  className="primary"
                  data-testid="code-settings-update-action"
                  onClick={startUpgrade}
                  disabled={updateBusy || !selectedVersion?.available}
                >{updateActionLabel}</button>
              </div>
              {bundleUpdate && <label className="code-settings-update-url">
                <span>{copy.updateSource}</span>
                <input
                  type="url"
                  name="farming-update-url"
                  inputMode="url"
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  enterKeyHint="done"
                  data-lpignore="true"
                  data-1p-ignore="true"
                  data-bwignore="true"
                  data-form-type="other"
                  value={updateUrl}
                  placeholder={copy.updateUrlPlaceholder}
                  aria-label={copy.updateUrl}
                  onChange={event => setUpdateUrl(event.target.value)}
                  disabled={updateBusy}
                />
              </label>}
              {bundleUpdate && <button type="button" className="code-settings-update-save" onClick={saveUpdateUrl} disabled={updateBusy}>{copy.saveUpdateUrl}</button>}
              {updateVersions.length > 1 && <label className="code-settings-update-version">
                <select
                  value={selectedUpdateAsset}
                  aria-label={copy.targetVersion}
                  onChange={event => setSelectedUpdateAsset(event.target.value)}
                  disabled={updateBusy || updateVersions.length === 0}
                >
                  {updateVersions.map(version => (
                    <option key={version.assetName || version.version} value={version.assetName || ''}>
                      {(version.version || version.assetName || '-')}{version.assetName && version.assetName !== version.version ? ` · ${version.assetName}` : ''}
                    </option>
                  ))}
                </select>
              </label>}
            </div>
          </section>

          <section className="code-settings-section">
            <div className="code-settings-section-heading">
              <div>
                <h3>{copy.agentPermissions}</h3>
              </div>
            </div>
            <div className="code-settings-choice-row dangerous">
              <span>{copy.dangerousSkipLabel}</span>
              <button
                type="button"
                className={`code-settings-permission-toggle ${dangerouslySkipPermissions ? 'active' : ''}`}
                role="checkbox"
                aria-label={copy.dangerousSkipLabel}
                aria-pressed={dangerouslySkipPermissions}
                disabled={saving}
                onClick={() => saveDangerouslySkipPermissions(!dangerouslySkipPermissions)}
              ><CheckGlyph /></button>
            </div>
          </section>

          <section className="code-settings-section">
            <div className="code-settings-section-heading">
              <div>
                <h3>{copy.agentHomes}</h3>
                <p>{copy.agentHomesHint}</p>
              </div>
              {(loading || saving || notice) && (
                <span className="code-settings-status">{loading ? copy.loading : saving ? copy.saving : notice}</span>
              )}
            </div>
            {error && <div className="code-settings-error" role="alert">{error}</div>}

            {providers.length === 0 && <div className="code-agent-home-empty">{copy.noAgents}</div>}
            <div className="code-agent-homes-list">
              {providers.map(provider => {
                const providerHomes = homesForProvider(homes, provider)
                const providerAvailable = availableCodingProviders(agentLaunchOptions).includes(provider)
                const defaultHome = providerHomes.find(home => home.id.toLowerCase() === 'default')
                const customHomes = providerHomes.filter(home => home.id.toLowerCase() !== 'default')
                return (
                  <div className="code-agent-home-provider" key={provider}>
                    <div className="code-agent-home-provider-header">
                      <div className="code-agent-home-provider-title">
                        <strong>{providerDisplayName(provider)}{providerAvailable ? '' : ` · ${copy.unavailable}`}</strong>
                        {defaultHome && <span title={defaultHome.path}>{defaultHome.path} default</span>}
                      </div>
                      <button type="button" className="code-agent-home-add" onClick={() => {
                        setError('')
                        setNotice('')
                        setDraft(nextHomeDraft(provider))
                      }} aria-label={copy.addHome(providerDisplayName(provider))} title={copy.addHome(providerDisplayName(provider))}><PlusGlyph /></button>
                    </div>

                    {customHomes.map(home => (
                      <div className="code-agent-home-row" key={home.id}>
                        <div className="code-agent-home-path" title={home.path}>{home.path}</div>
                        <div className="code-agent-home-id">{home.id}</div>
                        <div className="code-agent-home-actions">
                          <button
                            type="button"
                            onClick={() => removeHome(provider, home.id)}
                            aria-label={copy.remove}
                            title={copy.remove}
                          ><CloseGlyph /></button>
                        </div>
                      </div>
                    ))}

                    {draft && draft.provider === provider && (
                      <div className="code-agent-home-form">
                        <label>
                          <span>{copy.homePath}</span>
                          <input
                            type="text"
                            name={`farming-agent-home-${provider}-path`}
                            inputMode="text"
                            autoComplete="off"
                            autoCorrect="off"
                            autoCapitalize="none"
                            spellCheck={false}
                            enterKeyHint="next"
                            data-lpignore="true"
                            data-1p-ignore="true"
                            data-bwignore="true"
                            data-form-type="other"
                            value={draft.path}
                            placeholder={copy.pathPlaceholder}
                            aria-label={copy.homePath}
                            onChange={event => setDraft(current => current ? { ...current, path: event.target.value } : current)}
                          />
                        </label>
                        <label>
                          <span>{copy.homeName}</span>
                          <input
                            type="text"
                            name={`farming-agent-home-${provider}-name`}
                            inputMode="text"
                            autoComplete="off"
                            autoCorrect="off"
                            autoCapitalize="none"
                            spellCheck={false}
                            enterKeyHint="done"
                            data-lpignore="true"
                            data-1p-ignore="true"
                            data-bwignore="true"
                            data-form-type="other"
                            value={draft.id}
                            placeholder={copy.homeNamePlaceholder}
                            aria-label={copy.homeName}
                            onChange={event => setDraft(current => current ? { ...current, id: event.target.value } : current)}
                          />
                          <span>{copy.homeNameHint}</span>
                        </label>
                        <div className="code-agent-home-form-actions">
                          <button type="button" onClick={() => setDraft(null)} aria-label={copy.cancel} title={copy.cancel}><CloseGlyph /></button>
                          <button type="button" className="primary" disabled={saving} onClick={submitDraft} aria-label={copy.save} title={copy.save}><CheckGlyph /></button>
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </section>
        </div>
      </aside>
    </div>
  )
}
