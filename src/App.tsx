import { useState, useCallback, useMemo, useEffect, useLayoutEffect, useRef } from 'react'
import { useWebSocket } from '@/hooks/useWebSocket'
import { usePageVisibility } from '@/hooks/usePageVisibility'
import { useAgents } from '@/hooks/useAgents'
import { useKeyboard, type Shortcut } from '@/hooks/useKeyboard'
import { InputDialog } from '@/components/InputDialog'
import { CodeWorkspace, type AgentFlagUpdateResult, type DeleteForkWorktreeProjectResult, type WorkspaceView } from '@/components/CodeWorkspace'
import { codeCopyForLanguage } from '@/components/code/copy'
import { applyThemeAppearance } from '@/lib/theme'
import { isIOSLikeTouchViewport, isMobileTouchViewport } from '@/lib/responsive-mode'
import {
  DEFAULT_UI_PREFERENCES,
  normalizeUiAppearance,
  normalizeUiLanguage,
  type UiPreferences,
} from '@/lib/ui-preferences'
import { destroyTerminalSession, pruneTerminalSessions } from '@/lib/terminal-session-pool'
import { appPath } from '@/lib/base-path'
import type { Agent, AgentContextWindowUsage, UsageSummary } from '@/types/agent'
import { loadCodeWorkspaceViewState, saveCodeWorkspaceViewState } from '@/components/code/workspace-view-state'

type DialogState = 'none' | 'input'
type AgentFlagPatch = Partial<{
  pinned: boolean
  unread: boolean
  archived: boolean
  launchPermissionMode: string
  readAttentionSeq: number
  agentRuntimeMode: 'terminal' | 'acp' | 'json'
}>
type StartAgentExtras = {
  projectWorkspace?: string
  task?: string
  workflowTemplate?: string
  customTitle?: string
  codexApprovalMode?: string
  codexRuntimeMode?: 'cli' | 'app-server'
  agentRuntimeMode?: 'terminal' | 'acp' | 'json'
  dangerouslySkipPermissions?: boolean
  providerHomeId?: string
}
type PermissionSwitchState = {
  originalAgentId: string
  agent: Agent
  kind: 'permission' | 'runtime'
  startedAt: number
  replacementAgentId?: string
  transitionFromAgentId?: string
  requestSettled?: boolean
  requestError?: string
  requestErrorAt?: number
  requestFreshStateAt?: number
}
type AgentReplacementTransition = { originalAgentId: string; replacementAgentId: string }

const CODEX_SKIN_KEYBOARD_SHORTCUTS_ENABLED = false
const BACKEND_INITIAL_CONNECT_GRACE_MS = 3000
const BACKEND_HEARTBEAT_STALE_MS = 6000
const MIN_MOBILE_VISUAL_HEIGHT = 240
const CONTEXT_WINDOW_REFRESH_MS = 30_000
const PERMISSION_SWITCH_REPLACEMENT_GRACE_MS = 10_000
const PERMISSION_SWITCH_REPLACEMENT_HARD_TIMEOUT_MS = 60_000
const AGENT_SWITCH_REQUEST_TIMEOUT_MS = 45_000
const AGENT_SWITCH_OVERLAY_TIMEOUT_MS = 60_000

function projectWorkspaceForAgent(agent: { cwd: string; projectWorkspace?: string; isMain?: boolean } | null | undefined) {
  if (!agent) return undefined
  if (agent.projectWorkspace) return agent.projectWorkspace
  return agent.cwd
}

function isOpenableAgent(agent: Agent) {
  return !agent.archived && agent.status !== 'dead' && agent.status !== 'stopped'
}

function isRestartDescendantOf(agent: Agent, ancestorAgentId: string) {
  return agent.restartedFromAgentId === ancestorAgentId
    || agent.restartedFromAgentIds?.includes(ancestorAgentId) === true
}

function latestRestartDescendant(agents: Agent[], ancestorAgentId: string, expectedSession?: Agent | null) {
  return agents
    .filter(agent => (
      isOpenableAgent(agent)
      && isRestartDescendantOf(agent, ancestorAgentId)
      && (
        !expectedSession?.providerSessionProvider
        || !expectedSession.providerSessionId
        || (
          agent.providerSessionProvider === expectedSession.providerSessionProvider
          && (
            expectedSession.providerSessionTemporary === true
            || agent.providerSessionId === expectedSession.providerSessionId
          )
          && (agent.providerHomeId || '') === (expectedSession.providerHomeId || '')
        )
      )
    ))
    .sort((a, b) => {
      const lineageDifference = (b.restartedFromAgentIds?.length ?? 0) - (a.restartedFromAgentIds?.length ?? 0)
      if (lineageDifference !== 0) return lineageDifference
      return (b.startedAt ?? 0) - (a.startedAt ?? 0)
    })[0] ?? null
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
  const [initialWorkspaceViewState] = useState(() => loadCodeWorkspaceViewState())

  const [dialog, setDialog] = useState<DialogState>('none')
  const [inputInitialWorkspace, setInputInitialWorkspace] = useState<string | undefined>(undefined)
  const [inputInitialCommand, setInputInitialCommand] = useState<string | undefined>(undefined)
  const [inputInitialCustomTitle, setInputInitialCustomTitle] = useState<string | undefined>(undefined)
  const [openTerminalIds, setOpenTerminalIds] = useState<string[]>(() => initialWorkspaceViewState.openTerminalIds ?? [])
  const [activeTerminalId, setActiveTerminalId] = useState<string | null>(() => initialWorkspaceViewState.activeTerminalId ?? null)
  const [terminalFocusRequest, setTerminalFocusRequest] = useState<{ agentId: string; nonce: number } | null>(null)
  const [pendingTerminalOpen, setPendingTerminalOpen] = useState<{
    agentId: string
    options?: { focusTerminal?: boolean }
  } | null>(null)
  const [activeWorkspaceView, setActiveWorkspaceView] = useState<WorkspaceView>(() => initialWorkspaceViewState.activeView ?? 'projects')
  const [appNotice, setAppNotice] = useState<{ id: number; kind: 'error'; message: string } | null>(null)
  const [permissionSwitch, setPermissionSwitch] = useState<PermissionSwitchState | null>(null)
  const [externalAgentReplacement, setExternalAgentReplacement] = useState<AgentReplacementTransition | null>(null)
  const [usageSummary, setUsageSummary] = useState<UsageSummary | null>(null)
  const [contextWindowByAgentId, setContextWindowByAgentId] = useState<Record<string, AgentContextWindowUsage>>({})
  const [uiPreferences, setUiPreferences] = useState<UiPreferences>(DEFAULT_UI_PREFERENCES)
  const [connectionCheckNow, setConnectionCheckNow] = useState(() => Date.now())
  const pendingStartRef = useRef<{ beforeIds: Set<string> } | null>(null)
  const pendingMainRestartRef = useRef<{ beforeIds: Set<string> } | null>(null)
  const permissionSwitchRequestRef = useRef<string | null>(null)
  const permissionSwitchStateRef = useRef<PermissionSwitchState | null>(null)
  const openTerminalIdsRef = useRef<string[]>([])
  const hiddenMainStartRequestedRef = useRef(false)
  const didAutoOpenInitialTerminalRef = useRef(false)
  const didApplyAgentDeeplinkRef = useRef(false)
  const lastActiveWorkspaceRef = useRef<string | undefined>(undefined)
  const inputDialogReturnFocusRef = useRef<HTMLElement | null>(null)
  const inputDialogOpenRequestRef = useRef(0)

  useLayoutEffect(() => {
    openTerminalIdsRef.current = openTerminalIds
  }, [openTerminalIds])

  useEffect(() => {
    saveCodeWorkspaceViewState({
      activeTerminalId,
      activeView: activeWorkspaceView,
      openTerminalIds,
    })
  }, [activeTerminalId, activeWorkspaceView, openTerminalIds])

  const commitPermissionSwitch = useCallback((next: PermissionSwitchState | null) => {
    permissionSwitchStateRef.current = next
    setPermissionSwitch(next)
  }, [])

  const effectiveDialog = dialog
  const copy = useMemo(() => codeCopyForLanguage(uiPreferences.language), [uiPreferences.language])
  const displayedAgents = useMemo(() => {
    if (!permissionSwitch) {
      return ws.agents
    }
    const agents = ws.agents.filter(agent => (
      agent.id === permissionSwitch.agent.id
      || !isRestartDescendantOf(agent, permissionSwitch.originalAgentId)
    ))
    if (agents.some(agent => agent.id === permissionSwitch.agent.id)) return agents
    return [...agents, permissionSwitch.agent]
  }, [permissionSwitch, ws.agents])
  const observedAgentReplacements = useMemo(() => {
    const replacements = new Map<string, string>()
    const candidateIds = new Set(openTerminalIds)
    if (activeTerminalId) candidateIds.add(activeTerminalId)
    candidateIds.forEach(agentId => {
      if (displayedAgents.some(agent => agent.id === agentId && isOpenableAgent(agent))) return
      const replacement = latestRestartDescendant(displayedAgents, agentId)
      if (replacement) replacements.set(agentId, replacement.id)
    })
    return replacements
  }, [activeTerminalId, displayedAgents, openTerminalIds])
  const observedAgentReplacement = useMemo<AgentReplacementTransition | null>(() => {
    if (activeTerminalId) {
      const replacementAgentId = observedAgentReplacements.get(activeTerminalId)
      if (replacementAgentId) return { originalAgentId: activeTerminalId, replacementAgentId }
    }
    const first = observedAgentReplacements.entries().next().value as [string, string] | undefined
    return first ? { originalAgentId: first[0], replacementAgentId: first[1] } : null
  }, [activeTerminalId, observedAgentReplacements])
  const effectiveOpenTerminalIds = useMemo(() => Array.from(new Set(
    openTerminalIds.map(agentId => observedAgentReplacements.get(agentId) ?? agentId)
  )), [observedAgentReplacements, openTerminalIds])
  const effectiveActiveTerminalId = activeTerminalId
    ? observedAgentReplacements.get(activeTerminalId) ?? activeTerminalId
    : null

  useLayoutEffect(() => {
    if (!observedAgentReplacement) return
    setOpenTerminalIds(effectiveOpenTerminalIds)
    setActiveTerminalId(effectiveActiveTerminalId)
    setExternalAgentReplacement(observedAgentReplacement)
  }, [effectiveActiveTerminalId, effectiveOpenTerminalIds, observedAgentReplacement])

  useEffect(() => {
    if (!externalAgentReplacement || observedAgentReplacement) return
    setExternalAgentReplacement(null)
  }, [externalAgentReplacement, observedAgentReplacement])

  useEffect(() => {
    const current = permissionSwitchStateRef.current
    if (!current) return
    const replacement = latestRestartDescendant(ws.agents, current.originalAgentId, current.agent)
    if (!replacement || replacement.id === current.agent.id) return

    const transitionFromAgentId = current.agent.id
    const next = {
      ...current,
      agent: replacement,
      replacementAgentId: replacement.id,
      transitionFromAgentId,
    }
    setOpenTerminalIds(ids => Array.from(new Set(ids.map(id => (
      isRestartDescendantOf(replacement, id) ? replacement.id : id
    )))))
    setActiveTerminalId(activeId => (
      activeId && isRestartDescendantOf(replacement, activeId) ? replacement.id : activeId
    ))
    commitPermissionSwitch(next)
  }, [commitPermissionSwitch, permissionSwitch?.agent.id, permissionSwitch?.originalAgentId, ws.agents])

  useEffect(() => {
    const current = permissionSwitch
    if (!current?.requestSettled || !current.replacementAgentId) return
    if (!ws.agents.some(agent => agent.id === current.agent.id)) return
    if (permissionSwitchStateRef.current?.agent.id !== current.agent.id) return
    permissionSwitchRequestRef.current = null
    commitPermissionSwitch(null)
  }, [
    commitPermissionSwitch,
    permissionSwitch?.agent.id,
    permissionSwitch?.replacementAgentId,
    permissionSwitch?.requestSettled,
    ws.agents,
  ])

  useEffect(() => {
    const current = permissionSwitch
    if (!current?.requestSettled || !current.requestError || current.replacementAgentId) return undefined
    const errorAt = current.requestErrorAt ?? Date.now()
    if (!current.requestFreshStateAt && ws.connected && ws.lastMessageAt > errorAt) {
      const latest = permissionSwitchStateRef.current
      if (
        latest?.originalAgentId === current.originalAgentId
        && !latest.replacementAgentId
        && !latest.requestFreshStateAt
      ) {
        commitPermissionSwitch({ ...latest, requestFreshStateAt: ws.lastMessageAt })
      }
      return undefined
    }
    const hardDeadline = errorAt + PERMISSION_SWITCH_REPLACEMENT_HARD_TIMEOUT_MS
    const freshStateDeadline = current.requestFreshStateAt
      ? current.requestFreshStateAt + PERMISSION_SWITCH_REPLACEMENT_GRACE_MS
      : Number.POSITIVE_INFINITY
    const deadline = Math.min(hardDeadline, freshStateDeadline)
    const delay = Math.max(0, deadline - Date.now())
    const timer = window.setTimeout(() => {
      const latest = permissionSwitchStateRef.current
      if (
        !latest?.requestSettled
        || !latest.requestError
        || latest.replacementAgentId
        || latest.originalAgentId !== current.originalAgentId
      ) return
      permissionSwitchRequestRef.current = null
      commitPermissionSwitch(null)
      setAppNotice({ id: Date.now(), kind: 'error', message: latest.requestError })
    }, delay)
    return () => window.clearTimeout(timer)
  }, [commitPermissionSwitch, permissionSwitch, ws.connected, ws.lastMessageAt])

  useEffect(() => {
    const current = permissionSwitch
    if (!current) return undefined
    const delay = Math.max(0, current.startedAt + AGENT_SWITCH_OVERLAY_TIMEOUT_MS - Date.now())
    const timer = window.setTimeout(() => {
      const latest = permissionSwitchStateRef.current
      if (!latest || latest.startedAt !== current.startedAt) return
      permissionSwitchRequestRef.current = null
      commitPermissionSwitch(null)
      setAppNotice({ id: Date.now(), kind: 'error', message: copy.agentRestartTimedOut })
    }, delay)
    return () => window.clearTimeout(timer)
  }, [commitPermissionSwitch, copy.agentRestartTimedOut, permissionSwitch])
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
      const mobileViewport = isMobileTouchViewport()
      const layoutHeight = window.innerHeight || rawHeight || MIN_MOBILE_VISUAL_HEIGHT
      const height = mobileViewport
        ? Math.min(Math.max(rawHeight, MIN_MOBILE_VISUAL_HEIGHT), Math.max(layoutHeight, MIN_MOBILE_VISUAL_HEIGHT))
        : rawHeight
      const keyboardOffset = Math.max(0, layoutHeight - rawHeight - offsetTop)
      const iosLikeTouchViewport = mobileViewport && isIOSLikeTouchViewport()
      const mobileKeyboardActive = mobileViewport && keyboardOffset > 80
      const iosNavigator = navigator as Navigator & { standalone?: boolean }
      const standaloneWebApp = iosNavigator.standalone === true
        || window.matchMedia('(display-mode: standalone)').matches

      document.body.classList.toggle('code-mobile-touch', mobileViewport)
      document.body.classList.toggle('code-mobile-ios', iosLikeTouchViewport)
      document.body.classList.toggle('code-mobile-standalone', mobileViewport && standaloneWebApp)
      document.body.classList.toggle('code-mobile-keyboard-active', mobileKeyboardActive)
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
      document.body.classList.remove('code-mobile-touch')
      document.body.classList.remove('code-mobile-ios')
      document.body.classList.remove('code-mobile-standalone')
      document.body.classList.remove('code-mobile-keyboard-active')
    }
  }, [])

  const activateTerminal = useCallback((agentId: string, options?: { focusTerminal?: boolean }) => {
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

  // Keep the user intent separate from the authoritative agent list. A lifecycle
  // response may name an agent before the matching WebSocket state has rendered.
  const requestTerminalOpen = useCallback((agentId: string, options?: { focusTerminal?: boolean }) => {
    setPendingTerminalOpen({ agentId, options })
  }, [])

  const openTerminal = useCallback((agentId: string, options?: { focusTerminal?: boolean }) => {
    if (agentId === activeTerminalId && openTerminalIds.includes(agentId)) {
      activateTerminal(agentId, options)
      return
    }
    requestTerminalOpen(agentId, options)
  }, [activateTerminal, activeTerminalId, openTerminalIds, requestTerminalOpen])

  useEffect(() => {
    if (!pendingTerminalOpen) return
    if (!displayedAgents.some(agent => agent.id === pendingTerminalOpen.agentId && isOpenableAgent(agent))) return

    setPendingTerminalOpen(null)
    activateTerminal(pendingTerminalOpen.agentId, pendingTerminalOpen.options)
  }, [activateTerminal, displayedAgents, pendingTerminalOpen])

  const closeTerminals = useCallback((agentIds: Iterable<string>) => {
    const closingIds = new Set(agentIds)
    if (closingIds.size === 0) return
    const openIds = openTerminalIdsRef.current
    const activeIndex = openIds.indexOf(activeTerminalId ?? '')
    const remaining = openIds.filter(id => !closingIds.has(id))
    const nextActiveId = activeIndex === -1
      ? remaining[remaining.length - 1] ?? null
      : remaining[Math.min(activeIndex, remaining.length - 1)] ?? null

    openTerminalIdsRef.current = remaining
    setOpenTerminalIds(remaining)
    setActiveTerminalId(current => {
      if (!current || !closingIds.has(current)) return current
      return nextActiveId
    })
    if (activeTerminalId && closingIds.has(activeTerminalId) && nextActiveId) {
      setTerminalFocusRequest(previous => ({
        agentId: nextActiveId,
        nonce: (previous?.nonce ?? 0) + 1,
      }))
    }
  }, [activeTerminalId])

  const closeTerminal = useCallback((agentId: string) => {
    closeTerminals([agentId])
  }, [closeTerminals])

  const cycleOpenTerminal = useCallback((direction: 1 | -1) => {
    if (openTerminalIds.length === 0) return
    const currentIndex = Math.max(0, openTerminalIds.findIndex(id => id === activeTerminalId))
    const nextIndex = (currentIndex + direction + openTerminalIds.length) % openTerminalIds.length
    const nextId = openTerminalIds[nextIndex]
    if (nextId) openTerminal(nextId)
  }, [activeTerminalId, openTerminal, openTerminalIds])

  const openNewAgentDialog = useCallback((workspace?: string, command?: string, returnFocusTarget?: HTMLElement | null, customTitle?: string) => {
    const requestId = inputDialogOpenRequestRef.current + 1
    inputDialogOpenRequestRef.current = requestId
    inputDialogReturnFocusRef.current = returnFocusTarget ?? (document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null)
    setInputInitialWorkspace(workspace)
    setInputInitialCommand(command)
    setInputInitialCustomTitle(customTitle)
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

  const handleRestartMainAgent = useCallback((command: 'codex' | 'claude' | 'opencode' | 'qoder' | 'bash' | 'zsh') => {
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

  useEffect(() => {
    const agentId = ws.lastStartedAgentId
    const pending = pendingStartRef.current
    if (!agentId || !pending || pending.beforeIds.has(agentId)) return

    pendingStartRef.current = null
    setDialog('none')
    requestTerminalOpen(agentId)
  }, [requestTerminalOpen, ws.lastStartedAgentId])

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
      requestTerminalOpen(data.agentId)
    } catch (error) {
      notifyError(error instanceof Error ? error.message : 'Failed to fork agent')
    }
  }, [notifyError, requestTerminalOpen])

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
        closeTerminals(data.archivedAgentIds ?? [])
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
  }, [closeTerminals, notifyError])

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
    const permissionMode = typeof flags.launchPermissionMode === 'string'
      ? flags.launchPermissionMode
      : ''
    const runtimeSwitch = typeof flags.agentRuntimeMode === 'string'
    const permissionAgent = permissionMode || runtimeSwitch
      ? ws.agents.find(agent => agent.id === agentId) ?? null
      : null
    const switchingAgent = permissionAgent?.providerSessionProvider === 'codex'
      && permissionAgent.codexRuntimeMode === 'app-server'
      && !runtimeSwitch
      ? null
      : permissionAgent
    if (switchingAgent) {
      if (permissionSwitchRequestRef.current) return false
      permissionSwitchRequestRef.current = agentId
      commitPermissionSwitch({
        originalAgentId: agentId,
        agent: switchingAgent,
        kind: runtimeSwitch ? 'runtime' : 'permission',
        startedAt: Date.now(),
      })
    }

    const clearPermissionSwitch = () => {
      if (!switchingAgent) return
      const current = permissionSwitchStateRef.current
      if (current?.originalAgentId !== agentId) return
      permissionSwitchRequestRef.current = null
      commitPermissionSwitch(null)
    }

    try {
      const requestController = new AbortController()
      const requestTimeout = window.setTimeout(() => requestController.abort(), AGENT_SWITCH_REQUEST_TIMEOUT_MS)
      const response = await fetch(appPath(`/api/agents/${agentId}`), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(flags),
        signal: requestController.signal,
      })
      window.clearTimeout(requestTimeout)
      const data = await response.json().catch(() => null) as AgentFlagUpdateResult | null
      if (!response.ok) {
        const current = permissionSwitchStateRef.current
        if (switchingAgent && current?.originalAgentId === agentId && current.replacementAgentId) {
          commitPermissionSwitch({ ...current, requestSettled: true })
          return data ?? true
        }
        clearPermissionSwitch()
        notifyError(data?.error || `Failed to update agent (${response.status})`)
        return false
      }
      if (data?.warning) notifyError(data.warning)
      if (flags.archived === true) {
        closeTerminal(agentId)
      }
      if (data?.restartedAgentId) {
        const restartedAgentId = data.restartedAgentId
        const current = permissionSwitchStateRef.current
        if (switchingAgent && current?.originalAgentId === agentId) {
          if (current.agent.id === agentId) {
            setOpenTerminalIds(ids => ids.map(id => id === agentId ? restartedAgentId : id))
            setActiveTerminalId(activeId => activeId === agentId ? restartedAgentId : activeId)
            commitPermissionSwitch({
              ...current,
              replacementAgentId: restartedAgentId,
              transitionFromAgentId: agentId,
              requestSettled: true,
              agent: {
                ...current.agent,
                id: restartedAgentId,
                launchPermissionMode: data.launchPermissionMode ?? permissionMode,
                agentRuntimeMode: data.agentRuntimeMode ?? current.agent.agentRuntimeMode,
                restartedFromAgentId: agentId,
                restartedFromAgentIds: Array.from(new Set([
                  ...(current.agent.restartedFromAgentIds ?? []),
                  agentId,
                ])),
              },
            })
          } else {
            commitPermissionSwitch({
              ...current,
              requestSettled: true,
              requestError: undefined,
            })
          }
        }
      } else {
        clearPermissionSwitch()
      }
      return data ?? true
    } catch (error) {
      const message = error instanceof DOMException && error.name === 'AbortError'
        ? copy.agentRestartTimedOut
        : error instanceof Error ? error.message : 'Failed to update agent'
      const current = permissionSwitchStateRef.current
      if (switchingAgent && current?.originalAgentId === agentId) {
        commitPermissionSwitch({
          ...current,
          requestSettled: true,
          requestError: message,
          requestErrorAt: Date.now(),
        })
        return current.replacementAgentId ? true : false
      }
      notifyError(message)
      return false
    }
  }, [closeTerminal, commitPermissionSwitch, copy.agentRestartTimedOut, notifyError, ws.agents])

  const handleOpenArchivedAgent = useCallback(async (agentId: string) => {
    const updated = await handleUpdateAgentFlags(agentId, { archived: false })
    if (updated) {
      requestTerminalOpen(agentId)
    }
  }, [handleUpdateAgentFlags, requestTerminalOpen])

  // Focused agent for top-level labels
  const activeTerminalAgent = useMemo(
    () => displayedAgents.find(a => a.id === effectiveActiveTerminalId) ?? null,
    [displayedAgents, effectiveActiveTerminalId]
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
    if (!ws.error) return
    pendingStartRef.current = null
    setPendingTerminalOpen(null)
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
    const activeIds = displayedAgents.filter(isOpenableAgent).map(a => a.id)
    pruneTerminalSessions(activeIds).catch(error => {
      console.error('Failed to prune terminal sessions:', error)
    })
  }, [displayedAgents])

  useEffect(() => {
    const liveIds = new Set(displayedAgents.filter(isOpenableAgent).map(agent => agent.id))
    setOpenTerminalIds(ids => Array.from(new Set(ids.map(id => {
      if (liveIds.has(id)) return id
      return latestRestartDescendant(displayedAgents, id)?.id ?? id
    }))).filter(id => (
      liveIds.has(id) || permissionSwitchStateRef.current?.agent.id === id
    )))
  }, [displayedAgents])

  useEffect(() => {
    const liveIds = new Set(displayedAgents.filter(isOpenableAgent).map(agent => agent.id))
    setActiveTerminalId(current => {
      if (current && (
        liveIds.has(current)
        || permissionSwitchStateRef.current?.agent.id === current
      )) return current
      return openTerminalIds[0] ?? null
    })
  }, [displayedAgents, openTerminalIds])

  useEffect(() => {
    if (!displayedAgents.some(agent => !agent.isMain && isOpenableAgent(agent))) {
      didAutoOpenInitialTerminalRef.current = false
    }
  }, [displayedAgents])

  useEffect(() => {
    if (openTerminalIds.length > 0) return
    if (didAutoOpenInitialTerminalRef.current) return
    const fallbackId = displayedAgents.find(agent => !agent.isMain && isOpenableAgent(agent))?.id
    if (!fallbackId) return
    didAutoOpenInitialTerminalRef.current = true
    setOpenTerminalIds([fallbackId])
    setActiveTerminalId(fallbackId)
  }, [displayedAgents, openTerminalIds.length, ws.mainAgentId])

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

  useEffect(() => {
    document.body.classList.add('code-mode')
    return () => { document.body.classList.remove('code-mode') }
  }, [])

  useEffect(() => {
    applyThemeAppearance('terminal', {
      crtEffects: false,
      appearance: uiPreferences.appearance,
    })
  }, [uiPreferences.appearance])

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

  return (
    <div className="app-container code-app-shell" data-testid="app-shell">
      <CodeWorkspace
        agents={displayedAgents}
        taskHistory={ws.taskHistory}
        mainPageSessionKeys={ws.mainPageSessionKeys}
        activeView={activeWorkspaceView}
        dialogOpen={effectiveDialog !== 'none'}
        systemStats={ws.systemStats ?? usageSummary?.systemStats ?? null}
        usageSummary={usageSummary}
        contextWindowByAgentId={contextWindowByAgentId}
        activeTerminalId={effectiveActiveTerminalId}
        permissionSwitchingAgentId={permissionSwitch?.agent.id ?? null}
        agentSwitchingKind={permissionSwitch?.kind ?? null}
        permissionSwitchReplacement={permissionSwitch?.replacementAgentId
          ? {
            originalAgentId: permissionSwitch.transitionFromAgentId ?? permissionSwitch.originalAgentId,
            replacementAgentId: permissionSwitch.replacementAgentId,
          }
          : observedAgentReplacement ?? externalAgentReplacement}
        openTerminalIds={effectiveOpenTerminalIds}
        terminalFocusRequest={terminalFocusRequest}
        keyMap={keyMap}
        keyboardShortcutsEnabled={CODEX_SKIN_KEYBOARD_SHORTCUTS_ENABLED}
        uiPreferences={uiPreferences}
        onOpenTerminal={openTerminal}
        onOpenTerminalWhenReady={requestTerminalOpen}
        onNewAgent={openNewAgentDialog}
        onStartAgent={handleStartAgent}
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
        sendComposerInput={ws.sendComposerInput}
        respondToAppServerRequest={ws.respondToAppServerRequest}
        resizeAgent={ws.resizeAgent}
        onSessionOutput={ws.onSessionOutput}
        onUpdateUiPreferences={updateUiPreferences}
      />

      <InputDialog
        open={effectiveDialog === 'input'}
        mustStartMain={false}
        initialWorkspace={inputInitialWorkspace}
        initialCommand={inputInitialCommand}
        initialCustomTitle={inputInitialCustomTitle}
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
