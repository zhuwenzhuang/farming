import { useState, useCallback, useMemo, useEffect, useRef } from 'react'
import { useWebSocket } from '@/hooks/useWebSocket'
import { usePageVisibility } from '@/hooks/usePageVisibility'
import { useAgents } from '@/hooks/useAgents'
import { useKeyboard, type Shortcut } from '@/hooks/useKeyboard'
import { InputDialog } from '@/components/InputDialog'
import { CodeWorkspace, type AgentFlagUpdateResult, type DeleteForkWorktreeProjectResult, type WorkspaceView } from '@/components/CodeWorkspace'
import { codeCopyForLanguage } from '@/components/code/copy'
import { applyThemeAppearance, type ThemeRuntimeSettings } from '@/lib/theme'
import {
  DEFAULT_UI_PREFERENCES,
  normalizeUiAppearance,
  normalizeUiLanguage,
  type UiPreferences,
} from '@/lib/ui-preferences'
import { destroyTerminalSession, pruneTerminalSessions } from '@/lib/terminal-session-pool'
import { appPath } from '@/lib/base-path'
import type { Agent, AgentContextWindowUsage, UsageSummary } from '@/types/agent'

type DialogState = 'none' | 'input'
type AgentFlagPatch = Partial<{
  pinned: boolean
  unread: boolean
  archived: boolean
}>
type StartAgentExtras = {
  task?: string
  workflowTemplate?: string
}

const CODEX_SKIN_KEYBOARD_SHORTCUTS_ENABLED = false
const BACKEND_INITIAL_CONNECT_GRACE_MS = 3000
const BACKEND_HEARTBEAT_STALE_MS = 6000
const MIN_MOBILE_VISUAL_HEIGHT = 240
const CONTEXT_WINDOW_REFRESH_MS = 30_000

function projectWorkspaceForAgent(agent: { cwd: string; projectWorkspace?: string; isMain?: boolean } | null | undefined) {
  if (!agent) return undefined
  if (agent.projectWorkspace) return agent.projectWorkspace
  return agent.cwd
}

function isOpenableAgent(agent: Agent) {
  return !agent.archived && agent.status !== 'dead' && agent.status !== 'stopped'
}

function canReadCodexContextWindow(agent: Agent | null | undefined): agent is Agent & { providerSessionProvider: 'codex'; providerSessionId: string } {
  return agent?.providerSessionProvider === 'codex'
    && Boolean(agent.providerSessionId)
    && agent.providerSessionTemporary !== true
}

function isVisibleFocusTarget(element: HTMLElement | null): element is HTMLElement {
  if (!element || !element.isConnected) return false
  if (element.getAttribute('aria-disabled') === 'true') return false
  if ('disabled' in element && (element as HTMLButtonElement).disabled) return false

  const style = window.getComputedStyle(element)
  return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0
}

function focusVisibleTarget(element: HTMLElement | null) {
  if (!isVisibleFocusTarget(element)) return false
  element.focus({ preventScroll: true })
  return document.activeElement === element || element.contains(document.activeElement)
}

function hasBlockingOverlay() {
  return Boolean(document.querySelector('[role="dialog"], [role="menu"], .code-context-menu, .code-file-context-menu'))
}

export function App() {
  const ws = useWebSocket()
  const pageVisible = usePageVisibility()
  const { keyMap } = useAgents(ws.agents, ws.mainAgentId)

  const [dialog, setDialog] = useState<DialogState>('none')
  const [inputInitialWorkspace, setInputInitialWorkspace] = useState<string | undefined>(undefined)
  const [inputInitialCommand, setInputInitialCommand] = useState<string | undefined>(undefined)
  const [openTerminalIds, setOpenTerminalIds] = useState<string[]>([])
  const [activeTerminalId, setActiveTerminalId] = useState<string | null>(null)
  const [terminalFocusRequest, setTerminalFocusRequest] = useState<{ agentId: string; nonce: number } | null>(null)
  const [activeWorkspaceView, setActiveWorkspaceView] = useState<WorkspaceView>('projects')
  const [appNotice, setAppNotice] = useState<{ id: number; kind: 'error'; message: string } | null>(null)
  const [usageSummary, setUsageSummary] = useState<UsageSummary | null>(null)
  const [contextWindowByAgentId, setContextWindowByAgentId] = useState<Record<string, AgentContextWindowUsage>>({})
  const [themeRuntimeSettings, setThemeRuntimeSettings] = useState<ThemeRuntimeSettings>({})
  const [uiPreferences, setUiPreferences] = useState<UiPreferences>(DEFAULT_UI_PREFERENCES)
  const [connectionCheckNow, setConnectionCheckNow] = useState(() => Date.now())
  const pendingStartRef = useRef<{ beforeIds: Set<string> } | null>(null)
  const pendingMainRestartRef = useRef<{ beforeIds: Set<string> } | null>(null)
  const openTerminalIdsRef = useRef<string[]>([])
  const hiddenMainStartRequestedRef = useRef(false)
  const didAutoOpenInitialTerminalRef = useRef(false)
  const didApplyAgentDeeplinkRef = useRef(false)
  const lastActiveWorkspaceRef = useRef<string | undefined>(undefined)
  const inputDialogReturnFocusRef = useRef<HTMLElement | null>(null)
  const inputDialogOpenRequestRef = useRef(0)

  useEffect(() => {
    openTerminalIdsRef.current = openTerminalIds
  }, [openTerminalIds])

  const effectiveDialog = dialog
  const copy = useMemo(() => codeCopyForLanguage(uiPreferences.language), [uiPreferences.language])
  const backendConnectionState = useMemo(() => {
    const elapsed = Math.max(0, connectionCheckNow - ws.lastMessageAt)
    if (!ws.connected && ws.everConnected) return 'lost'
    if (!ws.connected && elapsed >= BACKEND_INITIAL_CONNECT_GRACE_MS) return 'connecting'
    if (ws.connected && elapsed >= BACKEND_HEARTBEAT_STALE_MS) return 'stale'
    return null
  }, [connectionCheckNow, ws.connected, ws.everConnected, ws.lastMessageAt])
  const backendConnectionMessage = backendConnectionState === 'lost'
    ? copy.backendConnectionLost
    : backendConnectionState === 'stale'
      ? copy.backendHeartbeatLost
      : backendConnectionState === 'connecting'
        ? copy.backendConnecting
        : ''

  useEffect(() => {
    if (!pageVisible) return undefined
    const timer = window.setInterval(() => setConnectionCheckNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [pageVisible])

  const updateUiPreferences = useCallback((patch: Partial<UiPreferences>) => {
    const nextPreferences = {
      appearance: normalizeUiAppearance(patch.appearance ?? uiPreferences.appearance),
      language: normalizeUiLanguage(patch.language ?? uiPreferences.language),
    }

    setUiPreferences(nextPreferences)
    fetch(appPath('/api/settings'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(nextPreferences),
    })
      .then(response => response.json())
      .then((data: { settings?: Partial<UiPreferences> }) => {
        const settings = data.settings ?? {}
        setUiPreferences({
          appearance: normalizeUiAppearance(settings.appearance ?? nextPreferences.appearance),
          language: normalizeUiLanguage(settings.language ?? nextPreferences.language),
        })
      })
      .catch(() => {
        setAppNotice({
          id: Date.now(),
          kind: 'error',
          message: 'Failed to save preferences',
        })
      })
  }, [uiPreferences.appearance, uiPreferences.language])

  const refreshAgentContextWindows = useCallback((agentIds: string[]) => {
    const uniqueAgentIds = Array.from(new Set(agentIds.filter(Boolean)))
    if (uniqueAgentIds.length === 0) return

    fetch(appPath('/api/codex/context-windows'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentIds: uniqueAgentIds }),
    })
      .then(response => response.json())
      .then((data: { contextWindows?: Array<AgentContextWindowUsage | { agentId?: string; available?: false }> }) => {
        const contextWindows = Array.isArray(data.contextWindows) ? data.contextWindows : []
        setContextWindowByAgentId(current => {
          const next = { ...current }
          contextWindows.forEach(item => {
            const agentId = String(item?.agentId || '')
            if (!agentId) return
            if (item && item.available === true) {
              next[agentId] = item
            } else {
              delete next[agentId]
            }
          })
          return next
        })
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    if (!ws.connected) return
    if (ws.mainAgentId || ws.agents.some(agent => agent.isMain)) {
      hiddenMainStartRequestedRef.current = false
      return
    }
    if (hiddenMainStartRequestedRef.current) return

    hiddenMainStartRequestedRef.current = true
    ws.startAgent('bash', undefined, true)
  }, [ws.agents, ws.connected, ws.mainAgentId, ws.startAgent])

  useEffect(() => {
    const updateVisualViewport = () => {
      const viewport = window.visualViewport
      const width = viewport?.width ?? window.innerWidth
      const rawHeight = viewport?.height ?? window.innerHeight
      const offsetTop = viewport?.offsetTop ?? 0
      const offsetLeft = viewport?.offsetLeft ?? 0
      const mobileViewport = window.matchMedia('(max-width: 980px)').matches
      const layoutHeight = window.innerHeight || rawHeight || MIN_MOBILE_VISUAL_HEIGHT
      const height = mobileViewport
        ? Math.min(Math.max(rawHeight, MIN_MOBILE_VISUAL_HEIGHT), Math.max(layoutHeight, MIN_MOBILE_VISUAL_HEIGHT))
        : rawHeight
      const keyboardOffset = Math.max(0, layoutHeight - rawHeight - offsetTop)

      document.documentElement.style.setProperty('--app-visual-width', `${width}px`)
      document.documentElement.style.setProperty('--app-visual-height', `${height}px`)
      document.documentElement.style.setProperty('--app-visual-offset-top', `${offsetTop}px`)
      document.documentElement.style.setProperty('--app-visual-offset-left', `${offsetLeft}px`)
      document.documentElement.style.setProperty('--mobile-keyboard-offset', `${keyboardOffset}px`)
    }

    updateVisualViewport()
    window.addEventListener('resize', updateVisualViewport)
    window.visualViewport?.addEventListener('resize', updateVisualViewport)
    window.visualViewport?.addEventListener('scroll', updateVisualViewport)

    return () => {
      window.removeEventListener('resize', updateVisualViewport)
      window.visualViewport?.removeEventListener('resize', updateVisualViewport)
      window.visualViewport?.removeEventListener('scroll', updateVisualViewport)
      document.documentElement.style.removeProperty('--app-visual-width')
      document.documentElement.style.removeProperty('--app-visual-height')
      document.documentElement.style.removeProperty('--app-visual-offset-top')
      document.documentElement.style.removeProperty('--app-visual-offset-left')
      document.documentElement.style.removeProperty('--mobile-keyboard-offset')
    }
  }, [])

  const openTerminal = useCallback((agentId: string, options?: { focusTerminal?: boolean }) => {
    if (activeTerminalId !== agentId) {
      ws.focusAgent(agentId)
    }
    setOpenTerminalIds(ids => ids.includes(agentId) ? ids : [...ids, agentId])
    setActiveTerminalId(agentId)
    setActiveWorkspaceView('projects')
    if (options?.focusTerminal !== false) {
      setTerminalFocusRequest(previous => ({
        agentId,
        nonce: (previous?.nonce ?? 0) + 1,
      }))
    }
    setDialog('none')
  }, [activeTerminalId, ws])

  const closeTerminal = useCallback((agentId: string) => {
    const openIds = openTerminalIdsRef.current
    const closedIndex = openIds.indexOf(agentId)
    const remaining = openIds.filter(id => id !== agentId)
    const nextActiveId = closedIndex === -1
      ? remaining[remaining.length - 1] ?? null
      : remaining[Math.min(closedIndex, remaining.length - 1)] ?? null

    setOpenTerminalIds(remaining)
    setActiveTerminalId(current => {
      if (current !== agentId) return current
      return nextActiveId
    })
    if (activeTerminalId === agentId && nextActiveId) {
      setTerminalFocusRequest(previous => ({
        agentId: nextActiveId,
        nonce: (previous?.nonce ?? 0) + 1,
      }))
    }
  }, [activeTerminalId])

  const cycleOpenTerminal = useCallback((direction: 1 | -1) => {
    if (openTerminalIds.length === 0) return
    const currentIndex = Math.max(0, openTerminalIds.findIndex(id => id === activeTerminalId))
    const nextIndex = (currentIndex + direction + openTerminalIds.length) % openTerminalIds.length
    const nextId = openTerminalIds[nextIndex]
    if (nextId) openTerminal(nextId)
  }, [activeTerminalId, openTerminal, openTerminalIds])

  const openNewAgentDialog = useCallback((workspace?: string, command?: string, returnFocusTarget?: HTMLElement | null) => {
    const requestId = inputDialogOpenRequestRef.current + 1
    inputDialogOpenRequestRef.current = requestId
    inputDialogReturnFocusRef.current = returnFocusTarget ?? (document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null)
    setInputInitialWorkspace(workspace)
    setInputInitialCommand(command)
    setActiveWorkspaceView('projects')
    setDialog('input')

    const keepDialogOpen = () => {
      if (inputDialogOpenRequestRef.current !== requestId) return
      setDialog(current => current === 'input' ? current : 'input')
    }
    window.requestAnimationFrame(keepDialogOpen)
    window.setTimeout(keepDialogOpen, 80)
    window.setTimeout(keepDialogOpen, 180)
  }, [])

  const restoreInputDialogFocus = useCallback(() => {
    const returnTarget = inputDialogReturnFocusRef.current
    const preferNewAgent = returnTarget?.getAttribute('data-testid') === 'code-new-agent'
    inputDialogReturnFocusRef.current = null

    const restoreFocus = () => {
      if (focusVisibleTarget(returnTarget)) return
      if (preferNewAgent && focusVisibleTarget(document.querySelector<HTMLElement>('[data-testid="code-new-agent"]'))) return

      const activeRow = activeTerminalId
        ? Array.from(document.querySelectorAll<HTMLElement>('[data-testid="code-agent-row"]'))
          .find(row => row.dataset.agentId === activeTerminalId)
        : null
      if (focusVisibleTarget(activeRow ?? null)) return

      if (focusVisibleTarget(document.querySelector<HTMLElement>('[data-testid="code-new-agent"]'))) return
      focusVisibleTarget(document.querySelector<HTMLElement>('[data-testid="code-project-list"]'))
    }

    window.requestAnimationFrame(restoreFocus)
    window.setTimeout(restoreFocus, 80)
    window.setTimeout(restoreFocus, 180)
  }, [activeTerminalId])

  const closeInputDialog = useCallback(() => {
    inputDialogOpenRequestRef.current += 1
    setDialog('none')
    restoreInputDialogFocus()
  }, [restoreInputDialogFocus])

  const notifyError = useCallback((message: string) => {
    setAppNotice({ id: Date.now(), kind: 'error', message })
  }, [])

  const handleKill = useCallback((agentId: string) => {
    destroyTerminalSession(agentId).catch(error => {
      console.error('Failed to destroy killed terminal session:', error)
    })
    ws.killAgent(agentId)
    closeTerminal(agentId)
  }, [ws, closeTerminal])

  const handleRestartMainAgent = useCallback((command: 'bash' | 'zsh' | 'codex' | 'claude') => {
    if (pendingMainRestartRef.current) return
    hiddenMainStartRequestedRef.current = true
    pendingMainRestartRef.current = { beforeIds: new Set(ws.agents.map(agent => agent.id)) }
    if (!ws.restartMainAgent(command)) {
      pendingMainRestartRef.current = null
      hiddenMainStartRequestedRef.current = false
    }
  }, [ws])

  const handleStartAgent = useCallback((command: string, workspace: string, extras?: StartAgentExtras) => {
    if (pendingStartRef.current) return
    inputDialogOpenRequestRef.current += 1
    pendingStartRef.current = { beforeIds: new Set(ws.agents.map(agent => agent.id)) }
    if (!ws.startAgent(command, workspace, false, extras)) {
      pendingStartRef.current = null
    }
  }, [ws])

  const handleForkAgent = useCallback(async (agentId: string, mode: 'same-worktree' | 'new-worktree') => {
    try {
      const response = await fetch(appPath(`/api/agents/${agentId}/fork`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
      })
      const data = await response.json().catch(() => null) as { agentId?: string; error?: string } | null
      if (!response.ok || !data?.agentId) {
        notifyError(data?.error || `Failed to fork agent (${response.status})`)
        return
      }
      openTerminal(data.agentId)
    } catch (error) {
      notifyError(error instanceof Error ? error.message : 'Failed to fork agent')
    }
  }, [notifyError, openTerminal])

  const handleDeleteForkWorktreeProject = useCallback(async (
    workspace: string,
    options?: { force?: boolean }
  ): Promise<DeleteForkWorktreeProjectResult> => {
    try {
      const response = await fetch(appPath('/api/projects/delete-worktree'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace, force: options?.force === true }),
      })
      const data = await response.json().catch(() => null) as DeleteForkWorktreeProjectResult | null
      if (!response.ok && data?.requiresForce !== true) {
        notifyError(data?.error || `Failed to delete worktree (${response.status})`)
      }
      if (data?.deleted) {
        ;(data.archivedAgentIds ?? []).forEach(agentId => {
          closeTerminal(agentId)
        })
      }
      if (data) return data
      const error = `Failed to delete worktree (${response.status})`
      notifyError(error)
      return { error }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to delete worktree'
      notifyError(message)
      return { error: message }
    }
  }, [closeTerminal, notifyError])

  const handleRenameAgent = useCallback(async (agentId: string, customTitle: string) => {
    try {
      const response = await fetch(appPath(`/api/agents/${agentId}`), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customTitle }),
      })
      const data = await response.json().catch(() => null) as { error?: string } | null
      if (!response.ok) {
        notifyError(data?.error || `Failed to rename agent (${response.status})`)
      }
    } catch (error) {
      notifyError(error instanceof Error ? error.message : 'Failed to rename agent')
    }
  }, [notifyError])

  const handleUpdateAgentFlags = useCallback(async (agentId: string, flags: AgentFlagPatch) => {
    try {
      const response = await fetch(appPath(`/api/agents/${agentId}`), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(flags),
      })
      const data = await response.json().catch(() => null) as AgentFlagUpdateResult | null
      if (!response.ok) {
        notifyError(data?.error || `Failed to update agent (${response.status})`)
        return false
      }
      if (flags.archived === true) {
        closeTerminal(agentId)
      }
      return data ?? true
    } catch (error) {
      notifyError(error instanceof Error ? error.message : 'Failed to update agent')
      return false
    }
  }, [closeTerminal, notifyError])

  const handleOpenArchivedAgent = useCallback(async (agentId: string) => {
    const updated = await handleUpdateAgentFlags(agentId, { archived: false })
    if (updated) {
      openTerminal(agentId)
    }
  }, [handleUpdateAgentFlags, openTerminal])

  // Focused agent for top-level labels
  const activeTerminalAgent = useMemo(
    () => ws.agents.find(a => a.id === activeTerminalId) ?? null,
    [ws.agents, activeTerminalId]
  )

  useEffect(() => {
    if (!pageVisible) return undefined
    if (!canReadCodexContextWindow(activeTerminalAgent)) return undefined

    const activeAgentId = activeTerminalAgent.id
    let firstLoadTimer: number | undefined
    let interval: number | undefined

    firstLoadTimer = window.setTimeout(() => refreshAgentContextWindows([activeAgentId]), 2500)
    interval = window.setInterval(() => refreshAgentContextWindows([activeAgentId]), CONTEXT_WINDOW_REFRESH_MS)

    return () => {
      if (firstLoadTimer !== undefined) window.clearTimeout(firstLoadTimer)
      if (interval !== undefined) window.clearInterval(interval)
    }
  }, [
    activeTerminalAgent?.id,
    activeTerminalAgent?.providerSessionId,
    activeTerminalAgent?.providerSessionProvider,
    activeTerminalAgent?.providerSessionTemporary,
    pageVisible,
    refreshAgentContextWindows,
  ])

  useEffect(() => {
    const workspace = projectWorkspaceForAgent(activeTerminalAgent)
    if (workspace) {
      lastActiveWorkspaceRef.current = workspace
    }
  }, [activeTerminalAgent])

  // Global keyboard shortcuts (active when no dialog is open)
  const globalShortcuts = useMemo(() => {
    if (!CODEX_SKIN_KEYBOARD_SHORTCUTS_ENABLED) return []

    const shortcuts: Shortcut[] = [
      {
        key: 'n',
        handler: () => {
          if (hasBlockingOverlay()) return
          openNewAgentDialog(projectWorkspaceForAgent(activeTerminalAgent) ?? lastActiveWorkspaceRef.current)
        },
      },
      { key: '[', meta: true, allowInInput: true, allowInTerminal: true, handler: () => cycleOpenTerminal(-1) },
      { key: ']', meta: true, allowInInput: true, allowInTerminal: true, handler: () => cycleOpenTerminal(1) },
    ]

    // 1-9 open agent sessions
    keyMap.forEach((agentId, key) => {
      shortcuts.push({ key, handler: () => openTerminal(agentId) })
      shortcuts.push({ key, ctrl: true, allowInInput: true, allowInTerminal: true, handler: () => openTerminal(agentId) })
    })

    return shortcuts
  }, [activeTerminalAgent, cycleOpenTerminal, keyMap, openNewAgentDialog, openTerminal])

  useKeyboard(globalShortcuts, CODEX_SKIN_KEYBOARD_SHORTCUTS_ENABLED && effectiveDialog === 'none')

  useEffect(() => {
    const pending = pendingStartRef.current
    if (!pending) return

    const nextAgent = ws.agents.find(agent => !agent.isMain && isOpenableAgent(agent) && !pending.beforeIds.has(agent.id))
    if (!nextAgent) return

    pendingStartRef.current = null
    setDialog('none')
    openTerminal(nextAgent.id)
  }, [openTerminal, ws.agents])

  useEffect(() => {
    if (!ws.error) return
    pendingStartRef.current = null
    pendingMainRestartRef.current = null
    hiddenMainStartRequestedRef.current = false
    notifyError(ws.error)
  }, [notifyError, ws.error, ws.errorId])

  useEffect(() => {
    if (!appNotice) return
    const timer = window.setTimeout(() => setAppNotice(null), 2800)
    return () => window.clearTimeout(timer)
  }, [appNotice])

  useEffect(() => {
    if (!pageVisible) return undefined
    let cancelled = false
    let timer: number | undefined
    let firstLoadTimer: number | undefined

    const loadUsage = () => {
      fetch(appPath('/api/usage'))
        .then(response => response.json())
        .then((data: { usage?: UsageSummary }) => {
          if (!cancelled) setUsageSummary(data.usage ?? null)
        })
        .catch(() => {
          if (!cancelled) setUsageSummary(null)
        })
    }

    firstLoadTimer = window.setTimeout(loadUsage, 1500)
    timer = window.setInterval(loadUsage, 60_000)

    return () => {
      cancelled = true
      if (firstLoadTimer !== undefined) window.clearTimeout(firstLoadTimer)
      if (timer !== undefined) window.clearInterval(timer)
    }
  }, [pageVisible])

  // Clean up pooled terminal instances for agents that no longer exist
  useEffect(() => {
    const activeIds = ws.agents.filter(isOpenableAgent).map(a => a.id)
    pruneTerminalSessions(activeIds).catch(error => {
      console.error('Failed to prune terminal sessions:', error)
    })
  }, [ws.agents])

  useEffect(() => {
    const liveIds = new Set(ws.agents.filter(isOpenableAgent).map(agent => agent.id))
    setOpenTerminalIds(ids => ids.filter(id => liveIds.has(id)))
  }, [ws.agents])

  useEffect(() => {
    setActiveTerminalId(current => {
      if (current && openTerminalIds.includes(current)) return current
      return openTerminalIds[0] ?? null
    })
  }, [openTerminalIds])

  useEffect(() => {
    if (!ws.agents.some(agent => !agent.isMain && isOpenableAgent(agent))) {
      didAutoOpenInitialTerminalRef.current = false
    }
  }, [ws.agents])

  useEffect(() => {
    if (openTerminalIds.length > 0) return
    if (didAutoOpenInitialTerminalRef.current) return
    const fallbackId = ws.agents.find(agent => !agent.isMain && isOpenableAgent(agent))?.id
    if (!fallbackId) return
    didAutoOpenInitialTerminalRef.current = true
    setOpenTerminalIds([fallbackId])
    setActiveTerminalId(fallbackId)
  }, [openTerminalIds.length, ws.agents, ws.mainAgentId])

  useEffect(() => {
    const pending = pendingMainRestartRef.current
    if (!pending) return

    const nextMain = ws.agents.find(agent => agent.isMain && !agent.archived && !pending.beforeIds.has(agent.id))
    if (!nextMain) return

    pendingMainRestartRef.current = null
    hiddenMainStartRequestedRef.current = false
    openTerminal(nextMain.id)
  }, [openTerminal, ws.agents])

  useEffect(() => {
    if (didApplyAgentDeeplinkRef.current || ws.agents.length === 0) return

    const agentId = new URLSearchParams(window.location.search).get('agent')
    if (!agentId) {
      didApplyAgentDeeplinkRef.current = true
      return
    }

    if (!ws.agents.some(agent => agent.id === agentId && !agent.archived)) return

    didApplyAgentDeeplinkRef.current = true
    openTerminal(agentId)
  }, [openTerminal, ws.agents])

  // Load CRT setting on startup (matching old frontend's loadThemes behavior)
  // Only apply if the setting has been explicitly saved; otherwise leave body class unchanged
  useEffect(() => {
    document.body.classList.add('code-mode')
    return () => { document.body.classList.remove('code-mode') }
  }, [])

  useEffect(() => {
    applyThemeAppearance('terminal', {
      ...themeRuntimeSettings,
      appearance: uiPreferences.appearance,
    })
  }, [themeRuntimeSettings, uiPreferences.appearance])

  useEffect(() => {
    let cancelled = false
    fetch(appPath('/api/settings'))
      .then(response => response.json())
      .then((data: { settings?: Partial<UiPreferences> }) => {
        if (cancelled) return
        const settings = data.settings ?? {}
        setUiPreferences({
          appearance: normalizeUiAppearance(settings.appearance),
          language: normalizeUiLanguage(settings.language),
        })
      })
      .catch(() => {})

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    fetch(appPath('/api/themes'))
      .then(r => r.json())
      .then((data: { current?: string }) => {
        const themeId = data.current || 'terminal'
        return fetch(appPath(`/api/themes/${themeId}/settings`))
      })
      .then(r => r.json())
      .then((data: { settings?: { crtEffects?: boolean } }) => {
        if (!cancelled) setThemeRuntimeSettings(data.settings || {})
      })
      .catch(() => {})

    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div className="app-container code-app-shell" data-testid="app-shell">
      <CodeWorkspace
        agents={ws.agents}
        taskHistory={ws.taskHistory}
        mainPageSessionKeys={ws.mainPageSessionKeys}
        activeView={activeWorkspaceView}
        dialogOpen={effectiveDialog !== 'none'}
        systemStats={ws.systemStats ?? usageSummary?.systemStats ?? null}
        usageSummary={usageSummary}
        contextWindowByAgentId={contextWindowByAgentId}
        activeTerminalId={activeTerminalId}
        openTerminalIds={openTerminalIds}
        terminalFocusRequest={terminalFocusRequest}
        keyMap={keyMap}
        keyboardShortcutsEnabled={CODEX_SKIN_KEYBOARD_SHORTCUTS_ENABLED}
        uiPreferences={uiPreferences}
        onOpenTerminal={openTerminal}
        onNewAgent={openNewAgentDialog}
        onRenameAgent={handleRenameAgent}
        onUpdateAgentFlags={handleUpdateAgentFlags}
        onOpenArchivedAgent={handleOpenArchivedAgent}
        onForkAgent={handleForkAgent}
        onDeleteForkWorktreeProject={handleDeleteForkWorktreeProject}
        onRestartMainAgent={handleRestartMainAgent}
        onWorkspaceViewChange={setActiveWorkspaceView}
        onKill={handleKill}
        onInterruptAgent={ws.interruptAgent}
        sendInput={ws.sendInput}
        resizeAgent={ws.resizeAgent}
        onSessionOutput={ws.onSessionOutput}
        onUpdateUiPreferences={updateUiPreferences}
      />

      <InputDialog
        open={effectiveDialog === 'input'}
        mustStartMain={false}
        initialWorkspace={inputInitialWorkspace}
        initialCommand={inputInitialCommand}
        showWorkflowTaskFields={false}
        copy={copy}
        onStart={handleStartAgent}
        onClose={closeInputDialog}
      />

      {backendConnectionState && (
        <div
          className={`connection-status ${backendConnectionState}`}
          data-testid="connection-status"
          role="status"
          aria-live="polite"
        >
          <span className="connection-status-dot" aria-hidden="true" />
          <span>{backendConnectionMessage}</span>
        </div>
      )}
      {appNotice && (
        <div className={`app-toast ${appNotice.kind}`} data-testid="app-toast" role="status">
          {appNotice.message}
        </div>
      )}
    </div>
  )
}
