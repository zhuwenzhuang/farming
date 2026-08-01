import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CheckGlyph, ChevronLeftGlyph, CloseGlyph, ColorModeGlyph, PlayGlyph } from '@/components/IconGlyphs'
import { CodeSelect } from '@/components/CodeSelect'
import { appPath } from '@/lib/base-path'
import {
  PET_SETTINGS_EVENT,
  REST_REMINDER_CUSTOM_MINUTES_MAX,
  REST_REMINDER_CUSTOM_MINUTES_MIN,
  REST_REMINDER_IDLE_RESET_MINUTES,
  REST_REMINDER_INTERVAL_PRESETS_SECONDS,
  REST_REMINDER_TEST_INTERVAL_SECONDS,
  isPetSettingsStorageKey,
  loadRestReminderIntervalSeconds,
  normalizeRestReminderIntervalSeconds,
  persistRestReminderIntervalSeconds,
  readPetAppearance,
  readRestReminderIntervalSeconds,
  savePetAppearance,
  restReminderSliderIntervalSeconds,
  restReminderSliderPosition,
  type PetAppearance,
} from '@/lib/pet/rest-reminder'
import {
  normalizeComposerFollowUpBehavior,
  type ComposerFollowUpBehavior,
  type UiPreferences,
} from '@/lib/ui-preferences'
import { MAX_CONTENT_FONT_SIZE, MIN_CONTENT_FONT_SIZE } from '@/lib/content-font-size'
import {
  AGENT_COMPLETION_NOTIFICATIONS_EVENT,
  AGENT_COMPLETION_NOTIFICATIONS_STORAGE_KEY,
  agentNotificationPermission,
  readAgentCompletionNotificationsEnabled,
  saveAgentCompletionNotificationsEnabled,
  type AgentNotificationPermission,
} from '@/lib/agent-completion-notifications'
import { usePetDefaultAppearance } from './pet/usePetDefaultAppearance'
import type { GlobalSettings } from './types'

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
  state?: {
    phase?: string
    error?: string
    version?: string
    previousVersion?: string
    receivedBytes?: number
    totalBytes?: number
    startedAt?: string
    preparedAt?: string
    completedAt?: string
  }
  checkedAt?: string
}

interface AgentHomesSettingsPanelProps {
  open: boolean
  activeAgentId?: string | null
  language: UiPreferences['language']
  uiPreferences: UiPreferences
  onClose: () => void
  onPreviewPetAppearance: (appearance: PetAppearance) => void
  onSyncUiPreferences: (preferences: Partial<UiPreferences>) => void
  onUpdateUiPreferences: (preferences: Partial<UiPreferences>) => void
}

const SEARCH_TIMEOUT_OPTIONS_SECONDS = [3, 5, 10, 15, 30, 60, 180]

function nearestSearchTimeoutSeconds(timeoutMs: number) {
  const seconds = timeoutMs / 1000
  return SEARCH_TIMEOUT_OPTIONS_SECONDS.reduce((closest, option) => (
    Math.abs(option - seconds) < Math.abs(closest - seconds) ? option : closest
  ))
}

function updateDownloadPercent(state: UpdateStatus['state']) {
  const receivedBytes = Number(state?.receivedBytes)
  const totalBytes = Number(state?.totalBytes)
  if (!Number.isFinite(receivedBytes) || !Number.isFinite(totalBytes) || totalBytes <= 0) return null
  return Math.max(0, Math.min(100, Math.floor((receivedBytes / totalBytes) * 100)))
}

function updateElapsedSeconds(state: UpdateStatus['state'], now = Date.now()) {
  const startedAt = Date.parse(String(state?.startedAt || ''))
  const completedAt = state?.completedAt
    ? Date.parse(state.completedAt)
    : (state?.preparedAt ? Date.parse(state.preparedAt) : now)
  if (!Number.isFinite(startedAt) || !Number.isFinite(completedAt) || completedAt < startedAt) return null
  return Math.floor((completedAt - startedAt) / 1000)
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
    system: zh ? '跟随系统' : 'System',
    light: zh ? '浅色' : 'Light',
    dark: zh ? '深色' : 'Dark',
    interface: zh ? '界面' : 'Interface',
    interfaceSkin: zh ? '界面皮肤' : 'Interface skin',
    contentTextSize: zh ? '正文字号' : 'Content text size',
    farmingCode: 'Farming Code',
    farmingCrt: 'Farming CRT',
    farmingPet: 'Farming Pet',
    petAppearance: zh ? '提醒样式' : 'Reminder style',
    softGlow: zh ? '柔光' : 'Soft glow',
    blackHole: zh ? '黑洞' : 'Black hole',
    previewAppearance: (appearance: PetAppearance) => {
      const appearanceName = appearance === 'black-hole'
        ? (zh ? '黑洞' : 'black hole')
        : (zh ? '柔光' : 'soft glow')
      return zh ? `预览${appearanceName}效果` : `Preview ${appearanceName}`
    },
    breakReminder: zh ? '休息提醒' : 'Break reminder',
    breakReminderHint: zh
      ? `按本页前台可见时间计时，离开 ${REST_REMINDER_IDLE_RESET_MINUTES} 分钟后重置；90 分钟及以上休息 10 分钟。`
      : `Counts foreground time in this tab; resets after ${REST_REMINDER_IDLE_RESET_MINUTES} minutes away. Intervals of 90 min or longer use a 10 min break.`,
    breakReminderValue: (seconds: number | null) => {
      if (!seconds || seconds <= 0) return zh ? '关闭' : 'Off'
      if (seconds === REST_REMINDER_TEST_INTERVAL_SECONDS) {
        return zh ? '5 秒（仅用于观察效果）' : '5 sec (preview only)'
      }
      const minutes = seconds / 60
      if (minutes % 60 === 0) {
        const hours = minutes / 60
        return zh ? `每 ${hours} 小时` : `Every ${hours} hr`
      }
      return zh ? `每 ${minutes} 分钟` : `Every ${minutes} min`
    },
    breakReminderOffMarker: zh ? '关闭' : 'Off',
    customBreakReminder: zh ? '自定义' : 'Custom',
    customBreakReminderMinutes: zh ? '自定义提醒间隔（分钟）' : 'Custom reminder interval in minutes',
    customBreakReminderUnit: zh ? '分钟' : 'min',
    language: zh ? '语言' : 'Language',
    english: 'English',
    chinese: '中文',
    search: zh ? '搜索' : 'Search',
    agent: 'Agent',
    agentCompletionNotifications: zh ? '允许消息通知' : 'Allow message notifications',
    agentCompletionNotificationsHint: zh
      ? 'ACP 回合完成或 Terminal Agent 主动请求通知时，在 Farming 不在前台的情况下显示系统通知。'
      : 'Show system notifications for ACP completion and Terminal Agent notification requests while Farming is not active.',
    agentCompletionNotificationsBlocked: zh
      ? '通知被浏览器阻止。请在站点设置中允许通知后重试。'
      : 'Notifications are blocked. Allow them in the browser site settings, then try again.',
    agentCompletionNotificationsUnsupported: zh
      ? '当前浏览器或 Farming URL 不支持系统通知；请使用支持通知的浏览器和 HTTPS 地址。'
      : 'System notifications require a supported browser and a secure HTTPS Farming URL.',
    followUpBehavior: zh ? '后续消息行为' : 'Follow-up behavior',
    followUpBehaviorHint: zh
      ? 'Agent 工作时，新消息默认排队到下一轮，或直接调整当前轮。按 ⌘/Ctrl + Enter 可仅对当前一条反向发送。'
      : 'While an Agent is working, queue messages for the next turn or steer the current turn. Press ⌘/Ctrl + Enter to use the opposite behavior once.',
    queue: 'Queue',
    steer: 'Steer',
    dangerousSkipLabel: zh ? '默认跳过所有 agent 权限检查' : 'Skip all agent permission checks by default',
    dangerousSkipHint: zh
      ? '开启后，新启动的 Codex、Claude、OpenCode、Qoder、Qwen、Aider、GitHub Copilot CLI、Amazon Q 等会使用各自的危险跳过权限 flag。只在可信沙箱中使用。'
      : 'When enabled, new Codex, Claude, OpenCode, Qoder, Qwen, Aider, GitHub Copilot CLI, Amazon Q, and similar agents launch with their provider-specific dangerous skip flags. Use only in trusted sandboxes.',
    searchTimeout: zh ? '搜索超时' : 'Search timeout',
    searchTimeoutValue: (seconds: number) => zh
      ? (seconds >= 60 ? `${seconds / 60} 分钟` : `${seconds} 秒`)
      : (seconds >= 60 ? `${seconds / 60} min` : `${seconds} sec`),
    updates: zh ? '更新' : 'Updates',
    refreshUpdates: zh ? '刷新' : 'Refresh',
    updateAction: zh ? '准备更新' : 'Prepare update',
    updateToVersion: (version: string) => zh ? `准备 ${version}` : `Prepare ${version}`,
    updating: zh ? '准备中…' : 'Preparing…',
    restartToUpdate: zh ? '重启并应用' : 'Restart to update',
    checkingUpdates: zh ? '正在检查更新…' : 'Checking for updates…',
    currentVersion: zh ? '当前版本' : 'Current',
    latestVersion: zh ? '最新版本' : 'Latest',
    targetVersion: zh ? '升级版本' : 'Target',
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
    updateDownloading: (percent: number | null) => percent === null
      ? (zh ? '正在下载更新包…' : 'Downloading update package…')
      : (zh ? `正在下载更新包 ${percent}%` : `Downloading update package ${percent}%`),
    updateExtracting: zh ? '正在解压更新包…' : 'Extracting update package…',
    updateInstalling: zh ? '正在准备更新…' : 'Preparing update…',
    updateReady: zh ? '更新已准备好，重启后应用。' : 'Update ready. Restart to apply it.',
    updateRestarting: zh ? '新版本已安装，正在重启 Farming。' : 'The new version is installed. Restarting Farming.',
    updateRollingBack: zh ? '正在回退到旧版本…' : 'Rolling back to the previous version…',
    updateSucceeded: zh ? '更新成功。' : 'Update completed.',
    updateRolledBack: zh ? '新版本启动失败，已回退到旧版本。' : 'The new version failed to start and Farming rolled back.',
    updateElapsed: (seconds: number) => {
      const minutes = Math.floor(seconds / 60)
      const remainingSeconds = seconds % 60
      if (zh) return `已用时 ${minutes > 0 ? `${minutes} 分 ` : ''}${remainingSeconds} 秒`
      return `Elapsed ${minutes > 0 ? `${minutes}m ` : ''}${remainingSeconds}s`
    },
    loading: zh ? '加载中…' : 'Loading…',
    saving: zh ? '保存中…' : 'Saving…',
    saved: zh ? '已保存' : 'Saved',
    loadFailed: zh ? '加载设置失败' : 'Failed to load settings',
    saveFailed: zh ? '保存失败' : 'Failed to save',
  }
}

export function AgentHomesSettingsPanel({
  open,
  activeAgentId = null,
  language,
  uiPreferences,
  onClose,
  onPreviewPetAppearance,
  onSyncUiPreferences,
  onUpdateUiPreferences,
}: AgentHomesSettingsPanelProps) {
  const copy = useMemo(() => panelCopy(language), [language])
  const defaultPetAppearance = usePetDefaultAppearance(uiPreferences.appearance)
  const closeButtonRef = useRef<HTMLButtonElement | null>(null)
  const searchTimeoutSaveTimerRef = useRef<number | null>(null)
  const restReminderSaveRequestRef = useRef(0)
  const upgradeTargetVersionRef = useRef('')
  const panelScopeRef = useRef({ open, generation: 0 })
  const settingsLoadRequestRef = useRef(0)
  const [dangerouslySkipPermissions, setDangerouslySkipPermissions] = useState(false)
  const [composerFollowUpBehavior, setComposerFollowUpBehavior] = useState<ComposerFollowUpBehavior | null>(null)
  const [searchTimeoutSeconds, setSearchTimeoutSeconds] = useState(15)
  const [searchTimeoutDraftSeconds, setSearchTimeoutDraftSeconds] = useState<number | null>(null)
  const [contentFontSizeDraft, setContentFontSizeDraft] = useState<number | null>(null)
  const [completionNotificationsEnabled, setCompletionNotificationsEnabled] = useState(false)
  const [completionNotificationPermission, setCompletionNotificationPermission] = useState<AgentNotificationPermission>(
    agentNotificationPermission,
  )
  const [restReminderIntervalSeconds, setRestReminderIntervalSecondsState] = useState<number | null>(
    readRestReminderIntervalSeconds,
  )
  const [restReminderSliderDraftSeconds, setRestReminderSliderDraftSeconds] = useState<number | null>(null)
  const [petAppearance, setPetAppearanceState] = useState<PetAppearance>(() => (
    readPetAppearance(undefined, defaultPetAppearance)
  ))
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null)
  const [selectedUpdateAsset, setSelectedUpdateAsset] = useState('')
  const [updateChecking, setUpdateChecking] = useState(false)
  const [updateError, setUpdateError] = useState('')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const initialSettingsLoading = loading && composerFollowUpBehavior === null
  if (panelScopeRef.current.open !== open) {
    panelScopeRef.current = {
      open,
      generation: panelScopeRef.current.generation + 1,
    }
  }

  const loadSettings = useCallback(() => {
    if (!panelScopeRef.current.open) return
    const generation = panelScopeRef.current.generation
    const requestId = settingsLoadRequestRef.current + 1
    settingsLoadRequestRef.current = requestId
    setLoading(true)
    setError('')
    fetch(appPath('/api/settings'))
      .then(async settingsResponse => {
        if (!settingsResponse.ok) throw new Error(copy.loadFailed)
        const data = await settingsResponse.json() as { settings?: GlobalSettings }
        if (
          settingsLoadRequestRef.current !== requestId
          || panelScopeRef.current.generation !== generation
          || !panelScopeRef.current.open
        ) return
        setDangerouslySkipPermissions(data.settings?.dangerouslySkipAgentPermissionsByDefault === true)
        const nextFollowUpBehavior = normalizeComposerFollowUpBehavior(
          data.settings?.composerFollowUpBehavior,
        )
        setComposerFollowUpBehavior(nextFollowUpBehavior)
        onSyncUiPreferences({ composerFollowUpBehavior: nextFollowUpBehavior })
        setSearchTimeoutSeconds(nearestSearchTimeoutSeconds(Number(data.settings?.searchTimeoutMs ?? 15000)))
      })
      .catch(() => {
        if (
          settingsLoadRequestRef.current === requestId
          && panelScopeRef.current.generation === generation
          && panelScopeRef.current.open
        ) setError(copy.loadFailed)
      })
      .finally(() => {
        if (
          settingsLoadRequestRef.current === requestId
          && panelScopeRef.current.generation === generation
          && panelScopeRef.current.open
        ) setLoading(false)
      })
  }, [copy.loadFailed, onSyncUiPreferences])

  // Unmount-only teardown; `panelScopeRef.current.open` is already kept in sync
  // during render above.
  useEffect(() => () => {
    panelScopeRef.current = {
      open: false,
      generation: panelScopeRef.current.generation + 1,
    }
    settingsLoadRequestRef.current += 1
    if (searchTimeoutSaveTimerRef.current !== null) window.clearTimeout(searchTimeoutSaveTimerRef.current)
  }, [])

  useEffect(() => {
    if (!open) return
    setSaving(false)
    const permission = agentNotificationPermission()
    setCompletionNotificationPermission(permission)
    setCompletionNotificationsEnabled(
      permission === 'granted' && readAgentCompletionNotificationsEnabled(),
    )
    loadRestReminderIntervalSeconds(defaultPetAppearance)
      .then(setRestReminderIntervalSecondsState)
    loadSettings()
    window.requestAnimationFrame(() => closeButtonRef.current?.focus({ preventScroll: true }))
  }, [defaultPetAppearance, loadSettings, open])

  useEffect(() => {
    setPetAppearanceState(readPetAppearance(undefined, defaultPetAppearance))
  }, [defaultPetAppearance, open])

  useEffect(() => {
    if (!open || composerFollowUpBehavior === null) return
    setComposerFollowUpBehavior(uiPreferences.composerFollowUpBehavior)
  }, [composerFollowUpBehavior, open, uiPreferences.composerFollowUpBehavior])

  useEffect(() => {
    const onSetting = (event: Event) => {
      const detail = (event as CustomEvent<{
        intervalSeconds?: number
        appearance?: PetAppearance
      }>).detail
      setRestReminderIntervalSecondsState(normalizeRestReminderIntervalSeconds(
        detail?.intervalSeconds,
      ))
      setPetAppearanceState(
        detail?.appearance ?? readPetAppearance(undefined, defaultPetAppearance),
      )
    }
    const onStorage = (event: StorageEvent) => {
      if (isPetSettingsStorageKey(event.key)) {
        setRestReminderIntervalSecondsState(readRestReminderIntervalSeconds())
        setPetAppearanceState(readPetAppearance(undefined, defaultPetAppearance))
      }
      if (event.key === AGENT_COMPLETION_NOTIFICATIONS_STORAGE_KEY) {
        const permission = agentNotificationPermission()
        setCompletionNotificationPermission(permission)
        setCompletionNotificationsEnabled(
          permission === 'granted' && readAgentCompletionNotificationsEnabled(),
        )
      }
    }
    const onCompletionNotificationSetting = () => {
      const permission = agentNotificationPermission()
      setCompletionNotificationPermission(permission)
      setCompletionNotificationsEnabled(
        permission === 'granted' && readAgentCompletionNotificationsEnabled(),
      )
    }
    window.addEventListener(PET_SETTINGS_EVENT, onSetting)
    window.addEventListener(AGENT_COMPLETION_NOTIFICATIONS_EVENT, onCompletionNotificationSetting)
    window.addEventListener('storage', onStorage)
    return () => {
      window.removeEventListener(PET_SETTINGS_EVENT, onSetting)
      window.removeEventListener(AGENT_COMPLETION_NOTIFICATIONS_EVENT, onCompletionNotificationSetting)
      window.removeEventListener('storage', onStorage)
    }
  }, [defaultPetAppearance])

  const toggleCompletionNotifications = useCallback(async () => {
    if (completionNotificationsEnabled) {
      if (saveAgentCompletionNotificationsEnabled(false)) setCompletionNotificationsEnabled(false)
      return
    }

    let permission = agentNotificationPermission()
    if (permission === 'default') {
      try {
        permission = await window.Notification.requestPermission()
      } catch {
        permission = agentNotificationPermission()
      }
    }
    setCompletionNotificationPermission(permission)
    if (permission !== 'granted') {
      saveAgentCompletionNotificationsEnabled(false)
      setCompletionNotificationsEnabled(false)
      return
    }
    if (saveAgentCompletionNotificationsEnabled(true)) setCompletionNotificationsEnabled(true)
  }, [completionNotificationsEnabled])

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

  const refreshUpdateStatus = useCallback((force = true, quiet = false) => {
    if (!quiet) {
      setUpdateChecking(true)
      setUpdateError('')
    }
    fetch(appPath(`/api/update${force ? '?force=1' : ''}`))
      .then(async response => {
        const data = await response.json().catch(() => null) as { update?: UpdateStatus; error?: string } | null
        if (!response.ok) throw new Error(data?.error || copy.loadFailed)
        const nextUpdate = data?.update ?? null
        setUpdateStatus(nextUpdate)
        const versions = nextUpdate?.versions ?? []
        setSelectedUpdateAsset(current => {
          if (nextUpdate?.state?.phase === 'ready-to-restart') {
            const preparedVersion = nextUpdate.state.version
            const prepared = versions.find(version => version.version === preparedVersion)
            if (prepared?.assetName) return prepared.assetName
          }
          if (current && versions.some(version => version.assetName === current)) return current
          return versions[0]?.assetName || ''
        })
      })
      .catch(error => {
        if (!quiet) setUpdateError(error instanceof Error ? error.message : copy.loadFailed)
      })
      .finally(() => {
        if (!quiet) setUpdateChecking(false)
      })
  }, [copy.loadFailed])

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

  const commitSearchTimeout = useCallback(() => {
    if (searchTimeoutDraftSeconds === null) return
    const seconds = searchTimeoutDraftSeconds
    setSearchTimeoutDraftSeconds(null)
    setSearchTimeout(seconds)
  }, [searchTimeoutDraftSeconds, setSearchTimeout])

  const commitContentFontSize = useCallback(() => {
    if (contentFontSizeDraft === null) return
    const contentFontSize = contentFontSizeDraft
    setContentFontSizeDraft(null)
    onUpdateUiPreferences({ codeContentFontSize: contentFontSize })
  }, [contentFontSizeDraft, onUpdateUiPreferences])

  const setRestReminderIntervalSeconds = useCallback(async (seconds: number) => {
    const requestId = restReminderSaveRequestRef.current + 1
    restReminderSaveRequestRef.current = requestId
    const previousSeconds = restReminderIntervalSeconds
    setRestReminderIntervalSecondsState(seconds)
    if (!await persistRestReminderIntervalSeconds(seconds, defaultPetAppearance)) {
      if (restReminderSaveRequestRef.current === requestId) {
        setRestReminderIntervalSecondsState(previousSeconds)
        setError(copy.saveFailed)
      }
      return false
    }
    if (restReminderSaveRequestRef.current === requestId) setError('')
    return true
  }, [copy.saveFailed, defaultPetAppearance, restReminderIntervalSeconds])

  const setPetAppearance = useCallback((appearance: PetAppearance) => {
    if (!savePetAppearance(appearance)) {
      setError(copy.saveFailed)
      return
    }
    setError('')
    setPetAppearanceState(appearance)
  }, [copy.saveFailed])

  const displayedRestReminderIntervalSeconds = restReminderSliderDraftSeconds
    ?? restReminderIntervalSeconds
  const restReminderSliderValue = restReminderSliderPosition(displayedRestReminderIntervalSeconds)

  const setRestReminderSliderValue = useCallback((value: number) => {
    setRestReminderSliderDraftSeconds(restReminderSliderIntervalSeconds(value))
  }, [])

  const commitRestReminderSliderValue = useCallback(() => {
    if (restReminderSliderDraftSeconds === null) return
    const seconds = restReminderSliderDraftSeconds
    setRestReminderSliderDraftSeconds(null)
    void setRestReminderIntervalSeconds(seconds)
  }, [restReminderSliderDraftSeconds, setRestReminderIntervalSeconds])

  const setCustomRestReminderMinutes = useCallback((value: string) => {
    if (value === '') {
      setRestReminderIntervalSeconds(0)
      return
    }
    const minutes = Number(value)
    if (
      Number.isInteger(minutes)
      && minutes >= REST_REMINDER_CUSTOM_MINUTES_MIN
      && minutes <= REST_REMINDER_CUSTOM_MINUTES_MAX
    ) setRestReminderIntervalSeconds(minutes * 60)
  }, [setRestReminderIntervalSeconds])

  const startUpgrade = useCallback(() => {
    const restartPreparedUpdate = updateStatus?.state?.phase === 'ready-to-restart'
    const selectedVersion = updateStatus?.versions?.find(version => version.assetName === selectedUpdateAsset)
    if (!restartPreparedUpdate && !selectedVersion?.available) {
      refreshUpdateStatus(true)
      return
    }

    setUpdateChecking(true)
    setUpdateError('')
    setNotice('')
    upgradeTargetVersionRef.current = restartPreparedUpdate
      ? (updateStatus?.state?.version || '')
      : (selectedVersion?.version || selectedVersion?.assetName || '')
    fetch(appPath(restartPreparedUpdate ? '/api/update/restart' : '/api/update/install'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(restartPreparedUpdate ? {} : { assetName: selectedUpdateAsset }),
    })
      .then(async response => {
        const data = await response.json().catch(() => null) as { update?: { state?: UpdateStatus['state'] }; error?: string } | null
        if (!response.ok) {
          throw new Error(data?.error || copy.saveFailed)
        }
        setUpdateStatus(current => ({
          ...(current ?? {}),
          state: data?.update?.state ?? current?.state,
        }))
      })
      .catch(error => {
        upgradeTargetVersionRef.current = ''
        setUpdateError(error instanceof Error ? error.message : copy.saveFailed)
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

  const saveComposerFollowUpBehavior = useCallback((behavior: ComposerFollowUpBehavior) => {
    setComposerFollowUpBehavior(behavior)
    onUpdateUiPreferences({ composerFollowUpBehavior: behavior })
  }, [onUpdateUiPreferences])

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

  const updateVersions = updateStatus?.versions ?? []
  const selectedVersion = updateVersions.find(version => version.assetName === selectedUpdateAsset)
  const updateInstallBusy = ['downloading', 'extracting', 'installing', 'restarting', 'rolling-back'].includes(updatePhase)
  const updateReadyToRestart = updatePhase === 'ready-to-restart'
  const updateBusy = updateChecking || updateInstallBusy
  const updateMethod = updateStatus?.method || updateStatus?.current?.type || ''
  const updateMethodLabel = copy.updateMethodLabel(updateMethod)
  const currentUpdateVersion = updateStatus?.current?.releaseVersion
    || updateStatus?.current?.packageVersion
    || updateStatus?.state?.previousVersion
    || '-'
  const latestUpdateVersion = updateStatus?.latest?.version || '-'
  const targetUpdateVersion = updateReadyToRestart
    ? (updateStatus?.state?.version || selectedVersion?.version || updateStatus?.selected?.version || latestUpdateVersion)
    : (selectedVersion?.version || updateStatus?.selected?.version || latestUpdateVersion)
  const showUpdateTransition = currentUpdateVersion !== '-'
    && targetUpdateVersion !== '-'
    && currentUpdateVersion !== targetUpdateVersion
    && (updateStatus?.available === true || updateBusy || updateReadyToRestart)
  const downloadPercent = updateDownloadPercent(updateStatus?.state)
  const updateSummary = !updateStatus
    ? copy.checkingUpdates
    : updatePhase === 'rolled-back'
      ? copy.updateRolledBack
      : updatePhase === 'failed' && updateStatus?.state?.error
        ? updateStatus.state.error
        : updatePhase === 'downloading'
          ? copy.updateDownloading(downloadPercent)
          : updateReadyToRestart
            ? copy.updateReady
            : updatePhase === 'extracting'
              ? copy.updateExtracting
              : updatePhase === 'installing'
                ? copy.updateInstalling
                : updatePhase === 'restarting'
                  ? copy.updateRestarting
                  : updatePhase === 'rolling-back'
                    ? copy.updateRollingBack
                    : updateStatus.available
                      ? copy.updateAvailable
                      : updatePhase === 'succeeded'
                        ? copy.updateSucceeded
                        : updateStatus.latest?.blockedReason || copy.upToDate
  const elapsedSeconds = (updateInstallBusy || updateReadyToRestart || ['succeeded', 'failed', 'rolled-back'].includes(updatePhase))
    ? updateElapsedSeconds(updateStatus?.state)
    : null
  const updateElapsed = elapsedSeconds === null ? '' : copy.updateElapsed(elapsedSeconds)
  const updateActionLabel = updateInstallBusy
    ? copy.updating
    : updateReadyToRestart
      ? copy.restartToUpdate
      : selectedVersion?.available && targetUpdateVersion !== '-'
        ? copy.updateToVersion(targetUpdateVersion)
        : copy.updateAction
  return (
    <div
      className="code-settings-panel-overlay"
      data-testid="code-settings-panel"
      data-pet-snapshot-exclude
      onPointerDown={event => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
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
                  <button type="button" className={uiPreferences.appearance === 'system' ? 'active' : ''} onClick={() => onUpdateUiPreferences({ appearance: 'system' })}>{copy.system}</button>
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
              <div className="code-settings-choice-row code-settings-content-font-size-row">
                <div className="code-settings-row-copy">
                  <strong>{copy.contentTextSize}</strong>
                </div>
                <input
                  type="range"
                  min={String(MIN_CONTENT_FONT_SIZE)}
                  max={String(MAX_CONTENT_FONT_SIZE)}
                  step="1"
                  value={contentFontSizeDraft ?? uiPreferences.codeContentFontSize}
                  aria-label={copy.contentTextSize}
                  onChange={event => setContentFontSizeDraft(Number(event.target.value))}
                  onPointerUp={commitContentFontSize}
                  onPointerCancel={commitContentFontSize}
                  onKeyUp={commitContentFontSize}
                  onBlur={commitContentFontSize}
                />
                <output>{contentFontSizeDraft ?? uiPreferences.codeContentFontSize} px</output>
              </div>
            </div>
          </section>

          <section className="code-settings-section code-settings-group">
            <div className="code-settings-section-heading">
              <div><h3>{copy.agent}</h3></div>
              {(initialSettingsLoading || saving || notice) && (
                <span className="code-settings-status">{initialSettingsLoading ? copy.loading : saving ? copy.saving : notice}</span>
              )}
            </div>
            <div className="code-settings-card">
              <div className="code-settings-choice-row" data-testid="code-settings-follow-up-behavior">
                <div className="code-settings-row-copy">
                  <strong>{copy.followUpBehavior}</strong>
                  <small>{copy.followUpBehaviorHint}</small>
                </div>
                <div className="code-settings-segmented" role="group" aria-label={copy.followUpBehavior}>
                  {(['queue', 'steer'] as const).map(behavior => (
                    <button
                      key={behavior}
                      type="button"
                      className={composerFollowUpBehavior === behavior ? 'active' : ''}
                      aria-pressed={composerFollowUpBehavior === behavior}
                      disabled={composerFollowUpBehavior === null}
                      onClick={() => saveComposerFollowUpBehavior(behavior)}
                    >
                      {behavior === 'queue' ? copy.queue : copy.steer}
                    </button>
                  ))}
                </div>
              </div>
              <div className="code-settings-choice-row" data-testid="code-settings-agent-completion-notifications">
                <div className="code-settings-row-copy">
                  <strong>{copy.agentCompletionNotifications}</strong>
                  <small>{completionNotificationPermission === 'unsupported'
                    ? copy.agentCompletionNotificationsUnsupported
                    : completionNotificationPermission === 'denied'
                      ? copy.agentCompletionNotificationsBlocked
                      : copy.agentCompletionNotificationsHint}</small>
                </div>
                <button
                  type="button"
                  className={`code-settings-permission-toggle ${completionNotificationsEnabled ? 'active' : ''}`}
                  role="switch"
                  aria-label={copy.agentCompletionNotifications}
                  aria-checked={completionNotificationsEnabled}
                  disabled={completionNotificationPermission === 'unsupported' || completionNotificationPermission === 'denied'}
                  onClick={() => void toggleCompletionNotifications()}
                ><CheckGlyph /></button>
              </div>
              <div className="code-settings-choice-row">
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
            </div>
            {error && <div className="code-settings-error" role="alert">{error}</div>}
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
                  value={SEARCH_TIMEOUT_OPTIONS_SECONDS.indexOf(
                    searchTimeoutDraftSeconds ?? searchTimeoutSeconds,
                  )}
                  aria-label={copy.searchTimeout}
                  onChange={event => setSearchTimeoutDraftSeconds(
                    SEARCH_TIMEOUT_OPTIONS_SECONDS[Number(event.target.value)] ?? 15,
                  )}
                  onPointerUp={commitSearchTimeout}
                  onPointerCancel={commitSearchTimeout}
                  onKeyUp={commitSearchTimeout}
                  onBlur={commitSearchTimeout}
                />
                <output>{copy.searchTimeoutValue(searchTimeoutDraftSeconds ?? searchTimeoutSeconds)}</output>
              </div>
            </div>
          </section>

          <section className="code-settings-section code-settings-group">
            <div className="code-settings-section-heading">
              <div><h3>{copy.farmingPet}</h3></div>
            </div>
            <div className="code-settings-card">
              <div className="code-settings-choice-row code-settings-pet-appearance-row">
                <div className="code-settings-row-copy">
                  <strong>{copy.petAppearance}</strong>
                </div>
                <div className="code-settings-pet-appearance-options" role="group" aria-label={copy.petAppearance}>
                  {(['glass', 'black-hole'] as const).map(option => (
                    <div className="code-settings-pet-appearance-option" key={option}>
                      <button
                        type="button"
                        className={`code-settings-pet-appearance-select${petAppearance === option ? ' selected' : ''}`}
                        aria-pressed={petAppearance === option}
                        onClick={() => setPetAppearance(option)}
                      >
                        <span className={`code-pet-appearance-icon ${option}`} aria-hidden="true" />
                        <span>{option === 'glass' ? copy.softGlow : copy.blackHole}</span>
                      </button>
                      <button
                        type="button"
                        className="code-settings-pet-appearance-preview"
                        aria-label={copy.previewAppearance(option)}
                        title={copy.previewAppearance(option)}
                        onClick={() => onPreviewPetAppearance(option)}
                      >
                        <PlayGlyph />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
              <div className="code-settings-choice-row code-settings-pet-rest-row">
                <div className="code-settings-row-copy">
                  <strong>{copy.breakReminder}</strong>
                  <small>{copy.breakReminderHint}</small>
                </div>
                <div className="code-settings-pet-rest-control">
                  <input
                    type="range"
                    min="0"
                    max={String(REST_REMINDER_INTERVAL_PRESETS_SECONDS.length - 1)}
                    step="any"
                    value={restReminderSliderValue}
                    aria-label={copy.breakReminder}
                    aria-valuetext={copy.breakReminderValue(displayedRestReminderIntervalSeconds)}
                    onChange={event => setRestReminderSliderValue(Number(event.target.value))}
                    onPointerUp={commitRestReminderSliderValue}
                    onPointerCancel={commitRestReminderSliderValue}
                    onKeyUp={commitRestReminderSliderValue}
                    onBlur={commitRestReminderSliderValue}
                  />
                  <span className="code-settings-pet-rest-off-marker">{copy.breakReminderOffMarker}</span>
                </div>
                <div className="code-settings-pet-rest-value">
                  <output>{copy.breakReminderValue(displayedRestReminderIntervalSeconds)}</output>
                  <label className="code-settings-pet-rest-custom">
                    <span>{copy.customBreakReminder}</span>
                    <input
                      type="number"
                      min={REST_REMINDER_CUSTOM_MINUTES_MIN}
                      max={REST_REMINDER_CUSTOM_MINUTES_MAX}
                      step="1"
                      value={restReminderIntervalSeconds && restReminderIntervalSeconds >= 60
                        ? restReminderIntervalSeconds / 60
                        : ''}
                      placeholder={`${REST_REMINDER_CUSTOM_MINUTES_MIN}–${REST_REMINDER_CUSTOM_MINUTES_MAX}`}
                      aria-label={copy.customBreakReminderMinutes}
                      onChange={event => setCustomRestReminderMinutes(event.currentTarget.value)}
                    />
                    <span>{copy.customBreakReminderUnit}</span>
                  </label>
                </div>
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
                  <span className="code-settings-update-summary-text">
                    {updateMethod && <><span>{updateMethodLabel}</span><span aria-hidden="true"> · </span></>}
                    <span>{updateSummary}</span>
                  </span>
                  {updateElapsed && <span className="code-settings-update-elapsed" aria-hidden="true">{updateElapsed}</span>}
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
                {(!updateStatus || updateMethod === 'npm') && <button
                  type="button"
                  className="primary"
                  data-testid="code-settings-update-action"
                  onClick={startUpgrade}
                  disabled={updateBusy || (!updateReadyToRestart && !selectedVersion?.available)}
                >{updateActionLabel}</button>}
              </div>
              {updateVersions.length > 1 && <CodeSelect
                className="code-settings-update-version"
                ariaLabel={copy.targetVersion}
                  value={selectedUpdateAsset}
                  disabled={updateBusy || updateReadyToRestart || updateVersions.length === 0}
                options={updateVersions.map(version => ({
                  value: version.assetName || '',
                  label: `${version.version || version.assetName || '-'}${version.assetName && version.assetName !== version.version ? ` · ${version.assetName}` : ''}`,
                }))}
                onChange={setSelectedUpdateAsset}
              />}
              {updateError && <div className="code-settings-error" role="alert">{updateError}</div>}
            </div>
          </section>

        </div>
      </aside>
    </div>
  )
}
