import type {
  DragEvent as ReactDragEvent,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  RefObject,
} from 'react'
import { createPortal } from 'react-dom'
import { lazy, memo, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  BellGlyph,
  BrowserGlyph,
  ChatBubblesGlyph,
  ChevronDownGlyph,
  ChevronLeftGlyph,
  ChevronRightGlyph,
  DesktopGlyph,
  FieldFlagGlyph,
  FocusModeGlyph,
  HistoryGlyph,
  NewAgentGlyph,
  PencilGlyph,
  PuzzleGlyph,
  SettingsGlyph,
  SearchGlyph,
  VisibilityGlyph,
  VisibilityOffGlyph,
} from '@/components/IconGlyphs'
import type {
  Agent,
  UsageSummary,
} from '@/types/agent'
import {
  fetchWorkspaceGitBranches,
  fetchWorkspaceGitWorktrees,
  switchWorkspaceGitBranch,
  WorkspaceFileApiError,
  type WorkspaceFileDeleteResult,
  type WorkspaceFileMove,
  type WorkspaceGitBranch,
  type WorkspaceGitBranches,
  type WorkspaceGitBranchSwitchResult,
  type WorkspaceGitWorktree,
  type WorkspaceGitWorktrees,
} from '@/lib/workspace-files'
import { appPath } from '@/lib/base-path'
import { isAcpRuntime } from '@/lib/agent-runtime'
import { agentDisplayName, formatRelativeAge } from '@/lib/format'
import { agentIconName, agentIconNameFromCommand, type AgentIconName } from '@/lib/agent-presentation'
import { GLOBAL_WORKSPACE_FILES_AGENT_ID } from '@/lib/global-workspace-files'
import { workspaceOpenFileKey } from '@/lib/workspace-open-files'
import type { OpenWorkspaceFile } from '@/lib/workspace-open-files'
import type { WorkspaceShareTarget } from '@/lib/workspace-share-target'
import {
  agentRowKey,
  buildAgentRowDisplayState,
} from './agent-row-state'
import type { CodeCopy } from './copy'
import {
  MAIN_AGENT_PROJECT_ID,
  agentSessionId,
  agentSessionProjectName,
  agentSessionUpdatedAt,
  projectNameForWorkspace,
} from './model'
import type { AgentSessionHistoryItem, ProjectGroup, WorkspaceFileOpenTarget, WorkspaceView } from './types'
import type { AgentLaunchOption } from './agent-launch-options'
import { AgentLaunchIcon } from './AgentLaunchIcon'
import { AppModeDialog } from './AppModeDialog'
import { BrandAboutDialog } from './BrandAboutDialog'
import { InstanceNameDialog } from './InstanceNameDialog'
import { mobileActionMenuPoint, outwardContextMenuPoint } from './menu-position'
import { ShareQrButton } from './ShareQrButton'
import { isCompactViewport, isTouchInputViewport } from '@/lib/responsive-mode'
import { projectFilesWorkspaceId } from '@/lib/project-workspaces'
import { formatWorkspaceForDisplay } from '@/lib/workspace-options'
import { recordPerformanceTestRender } from '@/lib/performance-test-observer'
import { stableProjectSourceAgentId } from './workspace-derived'
import { workspaceFileRevealScrollDelta } from '@/lib/workspace-file-view-model'
import { claimProjectListScroll, invalidateProjectListScroll } from '@/lib/project-list-scroll-owner'
import {
  loadCodeProjectFilesViewState,
  loadCodeWorkspaceViewState,
  saveCodeProjectFilesViewState,
  saveCodeWorkspaceViewState,
} from './workspace-view-state'
import {
  agentWithCurrentLiveState,
  projectAgentLiveSummary,
  useAgentWithLiveState,
  useDynamicPinProjectionRevision,
  useProjectAgentLiveSummary,
} from '@/lib/agent-live-state'
import {
  dynamicPinActivityAt,
  isAgentDynamicallyPinned,
} from '@/lib/dynamic-pinning'
import { useAgentReorder } from './useAgentReorder'
import { useDismissiblePopover } from './useDismissiblePopover'
import { UsagePanel } from './UsagePanel'
import { FarmingPet } from './pet/FarmingPet'
import type { UiAppearance, UiLanguage } from '@/lib/ui-preferences'
import { scheduleFocusRetries, scheduleFocusUntil } from './focus-retry'
import type { RequestOwnershipLease } from '@/lib/request-ownership'
import type { WorkspaceFileResolveOptions } from '@/lib/workspace-file-model-manager'

declare const __FARMING_PACKAGE_VERSION__: string

const PROJECT_AGENT_INITIAL_VISIBLE_LIMIT = 5
const PROJECT_AGENT_FIRST_REVEAL_COUNT = 5
const PROJECT_AGENT_NEXT_REVEAL_COUNT = 10
type AgentPreviewAnchorEvent = { currentTarget: HTMLElement }
type ContextMenuTriggerEvent = ReactMouseEvent<HTMLElement> | ReactKeyboardEvent<HTMLElement>

type AppInstallPromptEvent = Event & {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

function isStandaloneAppWindow() {
  if (typeof window === 'undefined') return false
  const iosNavigator = navigator as Navigator & { standalone?: boolean }
  return iosNavigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches
}

type AgentPreviewTarget = {
  key: string
  title: string
  project: string
  lastActive: number
  branch: string
  provider?: AgentIconName
  providerHomeId?: string
  browserCount?: number
  desktopCount?: number
}

type AgentResourceCounts = {
  browserCount: number
  desktopCount: number
}

type ProjectPreviewTarget = {
  key: string
  name: string
  workspace: string
  agentCount: number
  unreadCount: number
  runningCount: number
  branch: string
  worktreeCount: number
  pinned: boolean
}

const BRANCH_SWITCH_CLIENT_TIMEOUT_MS = 150_000

function previewAgentIconNameForAgent(agent: Agent): AgentIconName | undefined {
  return agentIconName(agent.providerSessionProvider) || agentIconNameFromCommand(agent.command)
}

type PinnedSidebarItem =
  | { kind: 'agent'; agent: Agent; dynamicallyPinned: boolean }
  | { kind: 'agent-session'; session: AgentSessionHistoryItem; dynamicallyPinned: false }

type SidebarRailItem = { agent: Agent; projectName: string }

function BranchGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="4" cy="3" r="1.5" />
      <circle cx="4" cy="13" r="1.5" />
      <circle cx="12" cy="5" r="1.5" />
      <path d="M4 4.5v7M5.5 8h2.25A4.25 4.25 0 0 0 12 3.75" />
    </svg>
  )
}

function compactProductVersion(version: string) {
  const normalized = version.trim().replace(/^v/i, '')
  if (!normalized) return ''

  const describedVersion = /^(\d+\.\d+\.\d+)-(\d+)-g[0-9a-f]+(?:-dirty)?$/i.exec(normalized)
  if (describedVersion) {
    return `${describedVersion[1]}-${describedVersion[2]}`
  }

  const dirtyVersion = /^(\d+\.\d+\.\d+)-dirty$/i.exec(normalized)
  if (dirtyVersion) {
    return `${dirtyVersion[1]}-1`
  }

  return normalized.replace(/-dirty$/i, '')
}

const ProjectFilesSection = lazy(() => import('../files/ProjectFilesSection').then(module => ({
  default: module.ProjectFilesSection,
})))

interface CodeSidebarProps {
  readOnly: boolean
  sidebarCollapsed: boolean
  navigationModalOpen: boolean
  navigationDialogRef: RefObject<HTMLElement | null>
  hoverPreviewsPaused: boolean
  emptyHomeActionRequest: { kind: 'share' | 'focus'; nonce: number } | null
  activeView: WorkspaceView
  searchOpen: boolean
  agentInventoryComplete: boolean
  displayedProjects: ProjectGroup[]
  collapsedProjectIds: Set<string>
  normalizedSearch: string
  hasProjectListItems: boolean
  hasDisplayedProjectListItems: boolean
  activeTerminalId: string | null
  selectedSearchAgentId: string | null
  selectedSearchSessionHandle: string | null
  claimedAgentSessionKeyByAgentId: ReadonlyMap<string, string>
  agentShortcutKeys: Map<string, string>
  keyboardShortcutsEnabled: boolean
  now: number
  mainAgent: Agent | null
  usageSummary: UsageSummary | null
  resourceCountsByAgentId: ReadonlyMap<string, AgentResourceCounts>
  instanceName: string
  language: UiLanguage
  appearancePreference: UiAppearance
  restReminderEntryBlocked: boolean
  shareTarget: WorkspaceShareTarget | null
  agentLaunchOptions: AgentLaunchOption[]
  agentCreationWorkspace?: string
  openWorkspaceFile: OpenWorkspaceFile | null
  openWorkspaceFiles: OpenWorkspaceFile[]
  agentRevealRequest: { agentId: string; requestId: number } | null
  fileRevealRequest: { agentId: string; path: string; kind: 'directory' | 'file'; requestId: number } | null
  fileSearchFocusRequest: { agentId: string; requestId: number; query?: string } | null
  onConsumeFileRevealRequest: (requestId: number) => boolean
  onConsumeFileSearchFocusRequest: (requestId: number) => boolean
  projectListRef: RefObject<HTMLDivElement | null>
  canLoadMoreAgentSessions: boolean
  onLoadMoreAgentSessions: () => void
  onNewAgent: (workspace?: string, command?: string, returnFocusTarget?: HTMLElement | null) => void
  onStartAgent: (command: string, workspace: string, options?: { projectWorkspace?: string; agentRuntimeMode?: 'terminal' | 'chat' | 'acp' }) => void
  onToggleSidebar: () => void
  onDismissNavigationModal: () => void
  onOpenSearch: () => void
  onOpenWorkspaceView: (view: WorkspaceView) => void
  onOpenMainAgent: () => void
  onRestartMainAgent: (command: string) => void
  onProjectListKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void
  onToggleProject: (projectId: string) => void
  onToggleProjectSessions: (projectId: string, direction: 'more' | 'less') => void
  onMountProject: (workspace: string) => void
  onOpenProjectMenu: (event: ContextMenuTriggerEvent, projectId: string, protectedAgentIds?: readonly string[]) => void
  onReorderProject: (workspace: string, beforeWorkspace: string, afterWorkspace: string) => void
  onOpenAgent: (agentId: string) => void
  onUpdateAgentFlags: (agent: Agent, flags: Partial<Pick<Agent, 'followUp' | 'pinned' | 'archived'>>) => void
  onReorderAgent: (agentId: string, beforeAgentId: string, afterAgentId: string) => void
  onOpenAgentMenu: (event: ContextMenuTriggerEvent, agentId: string) => void
  onResumeAgentSession: (provider: string, sessionId: string, providerHomeId?: string) => void
  onOpenAgentSessionMenu: (event: ContextMenuTriggerEvent, provider: string, sessionId: string) => void
  onToggleAgentSessionPinned: (session: AgentSessionHistoryItem) => void
  onArchiveAgentSession: (session: AgentSessionHistoryItem) => void
  onOpenProjectFile: (
    agentId: string,
    file: OpenWorkspaceFile['file'],
    target?: WorkspaceFileOpenTarget,
    signal?: AbortSignal,
    intentLease?: RequestOwnershipLease,
  ) => void | Promise<void>
  onBeginProjectFileOpenIntent: () => RequestOwnershipLease
  onResolveProjectFile: (
    rootId: string,
    filePath: string,
    options?: WorkspaceFileResolveOptions,
  ) => Promise<OpenWorkspaceFile['file']>
  onSelectOpenWorkspaceFile: (agentId: string, filePath: string, target?: WorkspaceFileOpenTarget) => boolean
  onCloseOpenWorkspaceFile: (agentId: string, filePath: string, workspaceRoot?: string) => void
  onMoveWorkspaceEntries: (agentId: string, moves: WorkspaceFileMove[]) => void
  onDeleteWorkspaceEntries: (agentId: string, deletions: WorkspaceFileDeleteResult[]) => void
  onRefreshProjectOpenFiles: (filesId: string, workspaceRoot: string) => Promise<boolean>
  onOpenOptionsMenu: (event: ReactMouseEvent<HTMLElement>) => void
  onRenameInstance: (name: string) => Promise<boolean>
  copy: CodeCopy
}

function trapFocusInContainer(event: ReactKeyboardEvent<HTMLElement>, container: HTMLElement) {
  if (event.key !== 'Tab') return

  const focusable = Array.from(container.querySelectorAll<HTMLElement>(
    'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [href], [tabindex]:not([tabindex="-1"])'
  )).filter(element => element.offsetParent !== null)
  if (focusable.length === 0) {
    event.preventDefault()
    return
  }

  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  const activeElement = document.activeElement
  if (event.shiftKey) {
    if (activeElement === first || !container.contains(activeElement)) {
      event.preventDefault()
      last?.focus()
    }
    return
  }

  if (activeElement === last || !container.contains(activeElement)) {
    event.preventDefault()
    first?.focus()
  }
}

export function CodeSidebar({
  readOnly,
  sidebarCollapsed,
  navigationModalOpen,
  navigationDialogRef,
  hoverPreviewsPaused,
  emptyHomeActionRequest,
  activeView,
  searchOpen,
  agentInventoryComplete,
  displayedProjects,
  collapsedProjectIds,
  normalizedSearch,
  hasProjectListItems,
  hasDisplayedProjectListItems,
  activeTerminalId,
  selectedSearchAgentId,
  selectedSearchSessionHandle,
  claimedAgentSessionKeyByAgentId,
  agentShortcutKeys,
  keyboardShortcutsEnabled,
  now,
  mainAgent,
  usageSummary,
  resourceCountsByAgentId,
  instanceName,
  language,
  appearancePreference,
  restReminderEntryBlocked,
  shareTarget,
  agentLaunchOptions,
  agentCreationWorkspace,
  openWorkspaceFile,
  openWorkspaceFiles,
  agentRevealRequest,
  fileRevealRequest,
  fileSearchFocusRequest,
  onConsumeFileRevealRequest,
  onConsumeFileSearchFocusRequest,
  projectListRef,
  canLoadMoreAgentSessions,
  onLoadMoreAgentSessions,
  onNewAgent,
  onStartAgent,
  onToggleSidebar,
  onDismissNavigationModal,
  onOpenSearch,
  onOpenWorkspaceView,
  onOpenMainAgent,
  onRestartMainAgent,
  onProjectListKeyDown,
  onToggleProject,
  onToggleProjectSessions,
  onMountProject,
  onOpenProjectMenu,
  onReorderProject,
  onOpenAgent,
  onUpdateAgentFlags,
  onReorderAgent,
  onOpenAgentMenu,
  onResumeAgentSession,
  onOpenAgentSessionMenu,
  onToggleAgentSessionPinned,
  onArchiveAgentSession,
  onOpenProjectFile,
  onBeginProjectFileOpenIntent,
  onResolveProjectFile,
  onSelectOpenWorkspaceFile,
  onCloseOpenWorkspaceFile,
  onMoveWorkspaceEntries,
  onDeleteWorkspaceEntries,
  onRefreshProjectOpenFiles,
  onOpenOptionsMenu,
  onRenameInstance,
  copy,
}: CodeSidebarProps) {
  const [agentPreview, setAgentPreview] = useState<(AgentPreviewTarget & {
    x: number
    y: number
    width: number
    branch: string
  }) | null>(null)
  const handledAgentRevealRequestRef = useRef(0)
  const consumeAgentRevealRequest = useCallback((requestId: number) => {
    if (requestId <= handledAgentRevealRequestRef.current) return false
    handledAgentRevealRequestRef.current = requestId
    return true
  }, [])
  const [projectPreview, setProjectPreview] = useState<(ProjectPreviewTarget & {
    x: number
    y: number
    width: number
  }) | null>(null)
  const previewTimerRef = useRef<number | null>(null)
  const previewBrowsingRef = useRef(false)
  const [initialWorkspaceViewState] = useState(() => loadCodeWorkspaceViewState())
  const [usageCollapsed, setUsageCollapsed] = useState(initialWorkspaceViewState.usageCollapsed ?? true)
  const [pinnedCollapsed, setPinnedCollapsed] = useState(initialWorkspaceViewState.pinnedCollapsed ?? false)
  const [dynamicPinningEnabled, setDynamicPinningEnabled] = useState(
    initialWorkspaceViewState.dynamicPinningEnabled ?? false,
  )
  const [brandDialogOpen, setBrandDialogOpen] = useState(false)
  const [instanceNameDialogOpen, setInstanceNameDialogOpen] = useState(false)
  const productMarkRef = useRef<HTMLButtonElement | null>(null)
  const instanceNameEditRef = useRef<HTMLButtonElement | null>(null)
  const closeBrandDialog = useCallback(() => setBrandDialogOpen(false), [])
  const closeInstanceNameDialog = useCallback(() => {
    setInstanceNameDialogOpen(false)
    scheduleFocusRetries(() => {
      const target = instanceNameEditRef.current
      if (!target) return
      target.focus({ preventScroll: true })
    }, { runNow: false, animationFrame: false, delays: [80, 180, 360] })
  }, [])
  const [focusModeActive, setFocusModeActive] = useState(false)
  const [focusModeSupported, setFocusModeSupported] = useState(false)
  const [standaloneAppWindow, setStandaloneAppWindow] = useState(isStandaloneAppWindow)
  const [appModeDialogOpen, setAppModeDialogOpen] = useState(false)
  const [appInstallPrompt, setAppInstallPrompt] = useState<AppInstallPromptEvent | null>(null)
  const desktopApp = Boolean(window.farmingDesktop)
  const handledEmptyHomeActionRef = useRef(0)
  const loadMoreNearProjectListEnd = useCallback((element: HTMLDivElement) => {
    if (!canLoadMoreAgentSessions) return
    const remaining = element.scrollHeight - element.scrollTop - element.clientHeight
    if (remaining <= 240) onLoadMoreAgentSessions()
  }, [canLoadMoreAgentSessions, onLoadMoreAgentSessions])

  useEffect(() => {
    saveCodeWorkspaceViewState({ pinnedCollapsed })
  }, [pinnedCollapsed])

  useEffect(() => {
    saveCodeWorkspaceViewState({ dynamicPinningEnabled })
  }, [dynamicPinningEnabled])

  useEffect(() => {
    saveCodeWorkspaceViewState({ usageCollapsed })
  }, [usageCollapsed])
  const clearPreviewTimer = useCallback(() => {
    if (previewTimerRef.current === null) return
    window.clearTimeout(previewTimerRef.current)
    previewTimerRef.current = null
  }, [])
  const hideAgentPreview = useCallback(() => {
    clearPreviewTimer()
    setAgentPreview(null)
    setProjectPreview(null)
  }, [clearPreviewTimer])
  const resetAgentPreview = useCallback(() => {
    previewBrowsingRef.current = false
    hideAgentPreview()
  }, [hideAgentPreview])
  const showAgentPreview = useCallback((event: AgentPreviewAnchorEvent, target: AgentPreviewTarget, compact = false) => {
    if (hoverPreviewsPaused) return
    clearPreviewTimer()
    const anchor = event.currentTarget
    const delay = previewBrowsingRef.current ? 0 : (compact ? 450 : 1500)
    previewTimerRef.current = window.setTimeout(() => {
      previewTimerRef.current = null
      if (!anchor.matches(':hover')) return
      const rect = anchor.getBoundingClientRect()
      const x = rect.right + 10
      const width = Math.min(320, window.innerWidth - x - 12)
      if (width < 200) return
      const y = Math.max(8, Math.min(rect.top - 4, window.innerHeight - 152))
      previewBrowsingRef.current = true
      setProjectPreview(null)
      setAgentPreview({ ...target, x, y, width })
    }, delay)
  }, [clearPreviewTimer, hoverPreviewsPaused])

  const visibleAgentPreview = useMemo(() => {
    if (!agentPreview) return null
    const agentId = agentPreview.key.startsWith('agent:')
      ? agentPreview.key.slice('agent:'.length)
      : ''
    const resourceCounts = agentId ? resourceCountsByAgentId.get(agentId) : undefined
    return {
      ...agentPreview,
      browserCount: resourceCounts?.browserCount ?? 0,
      desktopCount: resourceCounts?.desktopCount ?? 0,
    }
  }, [agentPreview, resourceCountsByAgentId])

  const showProjectPreview = useCallback((event: AgentPreviewAnchorEvent, target: ProjectPreviewTarget) => {
    if (hoverPreviewsPaused) return
    clearPreviewTimer()
    const anchor = event.currentTarget
    const delay = previewBrowsingRef.current ? 0 : 1500
    previewTimerRef.current = window.setTimeout(() => {
      previewTimerRef.current = null
      if (!anchor.matches(':hover')) return
      const rect = anchor.getBoundingClientRect()
      const x = rect.right + 10
      const width = Math.min(320, window.innerWidth - x - 12)
      if (width < 200) return
      const y = Math.max(8, Math.min(rect.top - 4, window.innerHeight - 188))
      previewBrowsingRef.current = true
      setAgentPreview(null)
      setProjectPreview({ ...target, x, y, width })
    }, delay)
  }, [clearPreviewTimer, hoverPreviewsPaused])

  useEffect(() => {
    if (hoverPreviewsPaused) resetAgentPreview()
  }, [hoverPreviewsPaused, resetAgentPreview])

  useEffect(() => () => clearPreviewTimer(), [clearPreviewTimer])

  useEffect(() => {
    setFocusModeSupported(Boolean(document.fullscreenEnabled && document.documentElement.requestFullscreen))
    const handleFullscreenChange = () => {
      setFocusModeActive(Boolean(document.fullscreenElement))
    }
    document.addEventListener('fullscreenchange', handleFullscreenChange)
    handleFullscreenChange()
    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange)
    }
  }, [])

  useEffect(() => {
    const standaloneQuery = window.matchMedia('(display-mode: standalone)')
    const updateStandaloneState = () => {
      const standalone = isStandaloneAppWindow()
      setStandaloneAppWindow(standalone)
      if (standalone) setAppModeDialogOpen(false)
    }
    const captureInstallPrompt = (event: Event) => {
      event.preventDefault()
      setAppInstallPrompt(event as AppInstallPromptEvent)
    }
    standaloneQuery.addEventListener('change', updateStandaloneState)
    window.addEventListener('beforeinstallprompt', captureInstallPrompt)
    updateStandaloneState()
    return () => {
      standaloneQuery.removeEventListener('change', updateStandaloneState)
      window.removeEventListener('beforeinstallprompt', captureInstallPrompt)
    }
  }, [])

  const toggleFocusMode = useCallback(() => {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {})
      return
    }
    document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => {})
  }, [])

  useEffect(() => {
    if (!emptyHomeActionRequest || handledEmptyHomeActionRef.current === emptyHomeActionRequest.nonce) return
    handledEmptyHomeActionRef.current = emptyHomeActionRequest.nonce
    if (emptyHomeActionRequest.kind !== 'focus') return
    if (desktopApp || standaloneAppWindow) {
      toggleFocusMode()
      return
    }
    setAppModeDialogOpen(true)
  }, [desktopApp, emptyHomeActionRequest, standaloneAppWindow, toggleFocusMode])
  const installApp = useCallback(() => {
    const prompt = appInstallPrompt
    if (!prompt) return
    void prompt.prompt()
      .then(() => prompt.userChoice)
      .then(choice => {
        setAppInstallPrompt(null)
        if (choice.outcome === 'accepted') setAppModeDialogOpen(false)
      })
      .catch(() => setAppInstallPrompt(null))
  }, [appInstallPrompt])
  const toggleFocusModeFromDialog = useCallback(() => {
    setAppModeDialogOpen(false)
    toggleFocusMode()
  }, [toggleFocusMode])
  const installUnavailableReason = window.isSecureContext
    ? copy.appModeInstallUnavailableBrowser
    : copy.appModeInstallUnavailableInsecure
  const dynamicPinProjectionRevision = useDynamicPinProjectionRevision()
  const liveAgents = useMemo(() => {
    void dynamicPinProjectionRevision
    return displayedProjects.flatMap(project => project.agents.map(agentWithCurrentLiveState))
  }, [displayedProjects, dynamicPinProjectionRevision])
  const liveAgentById = useMemo(
    () => new Map(liveAgents.map(agent => [agent.id, agent])),
    [liveAgents],
  )
  const dynamicallyPinnedAgentIds = useMemo(() => {
    const ids = new Set<string>()
    if (!dynamicPinningEnabled) return ids
    liveAgents.forEach(agent => {
      if (agent.pinned === true) return
      if (isAgentDynamicallyPinned(agent, now)) ids.add(agent.id)
    })
    return ids
  }, [dynamicPinningEnabled, liveAgents, now])
  const pinnedItems = displayedProjects
    .flatMap<PinnedSidebarItem>(project => [
      ...project.agents
        .filter(agent => agent.pinned || dynamicallyPinnedAgentIds.has(agent.id))
        .map(agent => ({
          kind: 'agent' as const,
          agent: liveAgentById.get(agent.id) ?? agent,
          dynamicallyPinned: agent.pinned !== true,
        })),
      ...project.agentSessions
        .filter(session => session.pinned)
        .map(session => ({ kind: 'agent-session' as const, session, dynamicallyPinned: false as const })),
    ])
    .sort((a, b) => {
      if (a.dynamicallyPinned !== b.dynamicallyPinned) return a.dynamicallyPinned ? 1 : -1
      if (a.dynamicallyPinned && b.dynamicallyPinned) return 0
      if (a.kind === 'agent' && b.kind === 'agent') {
        return (a.agent.pinnedOrder ?? 0) - (b.agent.pinnedOrder ?? 0)
          || (a.agent.startedAt ?? 0) - (b.agent.startedAt ?? 0)
      }
      if (a.kind !== b.kind) return a.kind === 'agent' ? -1 : 1
      if (a.kind === 'agent-session' && b.kind === 'agent-session') {
        return agentSessionUpdatedAt(b.session) - agentSessionUpdatedAt(a.session)
      }
      return 0
    })
  const pinnedAgentIds = new Set(pinnedItems.flatMap(item => (
    item.kind === 'agent' ? [item.agent.id] : []
  )))
  const hasUnread = liveAgents.some(agent => (
    agent.isMain !== true && agent.archived !== true && agent.unread === true
  )) || displayedProjects.some(project => (
    project.agentSessions.some(session => session.archived !== true && session.unread === true)
  ))
  const revealedAgentIsPinned = Boolean(agentRevealRequest && displayedProjects.some(project => (
    project.agents.some(agent => (
      agent.id === agentRevealRequest.agentId && pinnedAgentIds.has(agent.id)
    ))
  )))

  useEffect(() => {
    if (!revealedAgentIsPinned || !agentRevealRequest) return
    if (consumeAgentRevealRequest(agentRevealRequest.requestId)) setPinnedCollapsed(false)
  }, [agentRevealRequest, consumeAgentRevealRequest, revealedAgentIsPinned])

  useEffect(() => {
    if (!agentRevealRequest) return
    const ownedScroller = projectListRef.current
    const scrollLease = ownedScroller ? claimProjectListScroll(ownedScroller) : null
    return scheduleFocusUntil(() => {
      if (scrollLease && !scrollLease.isCurrent()) return true
      const scroller = projectListRef.current
      if (!scroller) return false
      const rows = Array.from(scroller.querySelectorAll<HTMLElement>(
        '[data-testid="code-agent-row"], [data-testid="code-project-agent-compact"], [data-testid="code-pinned-agent-compact"]',
      ))
      const row = rows.find(candidate => (
        candidate.dataset.agentId === agentRevealRequest.agentId
        && candidate.getClientRects().length > 0
      ))
      if (!row) return false

      const scrollerRect = scroller.getBoundingClientRect()
      const rowRect = row.getBoundingClientRect()
      const rowIsFullyVisible = rowRect.top >= scrollerRect.top && rowRect.bottom <= scrollerRect.bottom
      if (!rowIsFullyVisible) {
        scroller.scrollTop += workspaceFileRevealScrollDelta(scrollerRect, rowRect)
        return false
      }
      return true
    }, {
      initialDelay: 0,
      retryDelay: 80,
      maxAttempts: 8,
    })
  }, [agentRevealRequest, projectListRef])
  const visibleProjectSections = displayedProjects.filter(project => (
    project.agents.some(agent => !agent.pinned || !agent.isMain)
    || project.agentSessions.some(session => !session.pinned)
    || (project.hiddenAgentSessionCount ?? 0) > 0
    || project.hasOpenFile
    || Boolean(project.workspace)
  ))
  const reorderableProjects = visibleProjectSections.filter(project => (
    Boolean(project.workspace) && !project.hasMain
  ))
  const {
    agentDrag: projectDrag,
    beginAgentDrag: beginProjectDrag,
    dropAgent: dropProject,
    finishAgentDrag: finishProjectDrag,
    updateAgentDropTarget: updateProjectDropTarget,
  } = useAgentReorder(
    reorderableProjects,
    onReorderProject,
    hideAgentPreview,
    (source, target) => source.pinned === target.pinned,
  )
  const canDropProject = (targetProjectId: string) => {
    if (!projectDrag) return false
    const source = reorderableProjects.find(project => project.id === projectDrag.agentId)
    const target = reorderableProjects.find(project => project.id === targetProjectId)
    return Boolean(source && target && source.pinned === target.pinned)
  }
  const sidebarRailItems = displayedProjects.flatMap<SidebarRailItem>(project => [
    ...project.agents
      .filter(agent => !agent.isMain)
      .map(agent => ({ agent, projectName: project.name })),
  ])
  const currentVersion = compactProductVersion(__FARMING_PACKAGE_VERSION__ || '')
  const currentVersionLabel = currentVersion ? `v${currentVersion}` : ''
  // Keep the numeric agent rail for the collapsed sidebar only in this release.
  // The FILES-pressure compression path made single-agent projects collapse to "1",
  // which saved no space and made the expanded sidebar harder to scan.
  const agentCompressionActive = sidebarCollapsed

  return (
    <aside
      ref={navigationDialogRef}
      className={`code-sidebar ${sidebarCollapsed ? 'collapsed' : ''}`}
      data-testid="code-sidebar"
      role={navigationModalOpen ? 'dialog' : undefined}
      aria-modal={navigationModalOpen ? true : undefined}
      aria-label={navigationModalOpen ? copy.projectsAndAgents : undefined}
      onMouseLeave={resetAgentPreview}
      onPointerDownCapture={hideAgentPreview}
      onContextMenuCapture={hideAgentPreview}
      onKeyDown={event => {
        if (!navigationModalOpen || event.defaultPrevented) return
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          onDismissNavigationModal()
          return
        }
        trapFocusInContainer(event, event.currentTarget)
      }}
    >
      <div className="code-nav">
        <div className="code-nav-top-row">
          <button
            type="button"
            className="code-nav-item primary"
            data-testid="code-new-agent"
            onClick={event => onNewAgent(agentCreationWorkspace, undefined, event.currentTarget)}
          >
            <span className="code-nav-icon">
              <NewAgentGlyph />
            </span>
            <span>{copy.newAgent}</span>
            {keyboardShortcutsEnabled && <kbd>N</kbd>}
          </button>
          <ShareQrButton
            copy={copy}
            sidebarCollapsed={sidebarCollapsed}
            shareTarget={shareTarget}
            openRequest={emptyHomeActionRequest?.kind === 'share' ? emptyHomeActionRequest.nonce : 0}
          />
          {!standaloneAppWindow && !sidebarCollapsed && (
            <button
              type="button"
              className={`code-sidebar-focus-toggle ${focusModeActive ? 'active' : ''}`}
              data-testid="code-sidebar-focus-toggle"
              aria-label={desktopApp ? copy.emptyWorkspaceFocus : copy.appModeOpen}
              title={desktopApp ? copy.emptyWorkspaceFocus : copy.appModeOpen}
              aria-haspopup={desktopApp ? undefined : 'dialog'}
              aria-expanded={desktopApp ? undefined : appModeDialogOpen}
              onClick={desktopApp ? toggleFocusMode : () => setAppModeDialogOpen(true)}
            >
              <span className="code-sidebar-focus-icon">
                <FocusModeGlyph />
              </span>
            </button>
          )}
          {!sidebarCollapsed && (
            <>
              <button
                type="button"
                className={`code-sidebar-search-toggle ${activeView === 'search' || searchOpen ? 'active' : ''}`}
                data-testid="code-nav-search"
                aria-label={copy.search}
                title={copy.search}
                aria-pressed={activeView === 'search' || searchOpen}
                onClick={onOpenSearch}
              >
                <span className="code-sidebar-search-icon" aria-hidden="true">
                  <SearchGlyph />
                </span>
              </button>
              <button
                type="button"
                className={`code-sidebar-history-toggle ${activeView === 'history' ? 'active' : ''}`}
                data-testid="code-nav-history"
                aria-label={copy.history}
                title={copy.history}
                aria-pressed={activeView === 'history'}
                onClick={() => onOpenWorkspaceView('history')}
              >
                <span className="code-sidebar-history-icon" aria-hidden="true">
                  <HistoryGlyph />
                </span>
              </button>
              <button
                type="button"
                className={`code-sidebar-plugins-toggle ${activeView === 'plugins' ? 'active' : ''}`}
                data-testid="code-nav-plugins"
                aria-label={copy.plugins}
                title={copy.plugins}
                aria-pressed={activeView === 'plugins'}
                onClick={() => onOpenWorkspaceView('plugins')}
              >
                <span className="code-sidebar-plugins-icon" aria-hidden="true">
                  <PuzzleGlyph />
                </span>
              </button>
            </>
          )}
          <button
            type="button"
            className="code-sidebar-toggle"
            data-testid="code-sidebar-toggle"
            aria-label={navigationModalOpen ? copy.closeNavigation : sidebarCollapsed ? copy.expandSidebar : copy.collapseSidebar}
            title={navigationModalOpen ? copy.closeNavigation : sidebarCollapsed ? copy.expandSidebar : copy.collapseSidebar}
            onClick={onToggleSidebar}
          >
            <span
              className={`code-sidebar-toggle-icon ${sidebarCollapsed ? 'collapsed' : 'expanded'}`}
              aria-hidden="true"
            >
              {sidebarCollapsed ? <ChevronRightGlyph /> : <ChevronLeftGlyph />}
            </span>
          </button>
        </div>
      </div>

      {sidebarCollapsed && sidebarRailItems.length > 0 && (
        <AgentRail
          items={sidebarRailItems}
          activeTerminalId={activeTerminalId}
          now={now}
          onOpenAgent={onOpenAgent}
          onShowPreview={showAgentPreview}
          onHidePreview={hideAgentPreview}
          copy={copy}
        />
      )}

      <div
        className="code-project-list"
        data-testid="code-project-list"
        ref={projectListRef}
        tabIndex={0}
        onKeyDown={event => {
          invalidateProjectListScroll(event.currentTarget)
          onProjectListKeyDown(event)
        }}
        onPointerDownCapture={event => invalidateProjectListScroll(event.currentTarget)}
        onWheelCapture={event => invalidateProjectListScroll(event.currentTarget)}
        onScroll={event => loadMoreNearProjectListEnd(event.currentTarget)}
        aria-label={copy.projectsAndAgents}
      >
        {!hasProjectListItems && (
          <div className="code-empty-project">
            {copy.noAgentsYet}
          </div>
        )}
        {hasProjectListItems && !hasDisplayedProjectListItems && (
          <div className="code-empty-project" data-testid="code-empty-search">
            {copy.noMatchingProjectsOrAgents}
          </div>
        )}
        {pinnedItems.length > 0 && (
          <PinnedSection
            items={pinnedItems}
            collapsed={pinnedCollapsed}
            compressed={agentCompressionActive}
            dynamicPinningEnabled={dynamicPinningEnabled}
            hasUnread={hasUnread}
            activeTerminalId={activeTerminalId}
            selectedSearchAgentId={selectedSearchAgentId}
            selectedSearchSessionHandle={selectedSearchSessionHandle}
            claimedAgentSessionKeyByAgentId={claimedAgentSessionKeyByAgentId}
            agentShortcutKeys={agentShortcutKeys}
            keyboardShortcutsEnabled={keyboardShortcutsEnabled}
            now={now}
            onOpenAgent={onOpenAgent}
            onUpdateAgentFlags={onUpdateAgentFlags}
            onReorderAgent={onReorderAgent}
            onOpenAgentMenu={onOpenAgentMenu}
            onResumeAgentSession={onResumeAgentSession}
            onOpenAgentSessionMenu={onOpenAgentSessionMenu}
            onToggleAgentSessionPinned={onToggleAgentSessionPinned}
            onArchiveAgentSession={onArchiveAgentSession}
            onShowAgentPreview={showAgentPreview}
            onHideAgentPreview={hideAgentPreview}
            onToggleCollapsed={() => setPinnedCollapsed(collapsed => !collapsed)}
            onToggleDynamicPinning={() => setDynamicPinningEnabled(enabled => !enabled)}
            copy={copy}
          />
        )}
        {visibleProjectSections.map(project => (
          <ProjectSection
            key={project.id}
            project={project}
            readOnly={readOnly}
            agentInventoryComplete={agentInventoryComplete}
            collapsed={collapsedProjectIds.has(project.id) && !normalizedSearch}
            forceAgentsExpanded={Boolean(normalizedSearch)}
            compactAgents={agentCompressionActive}
            activeTerminalId={activeTerminalId}
            selectedSearchAgentId={selectedSearchAgentId}
            selectedSearchSessionHandle={selectedSearchSessionHandle}
            claimedAgentSessionKeyByAgentId={claimedAgentSessionKeyByAgentId}
            agentShortcutKeys={agentShortcutKeys}
            keyboardShortcutsEnabled={keyboardShortcutsEnabled}
            now={now}
            dynamicallyPinnedAgentIds={dynamicallyPinnedAgentIds}
            openWorkspaceFile={openWorkspaceFile}
            openWorkspaceFiles={openWorkspaceFiles}
            agentLaunchOptions={agentLaunchOptions}
            agentRevealRequest={agentRevealRequest}
            onConsumeAgentRevealRequest={consumeAgentRevealRequest}
            fileRevealRequest={fileRevealRequest}
            fileSearchFocusRequest={fileSearchFocusRequest}
            onConsumeFileRevealRequest={onConsumeFileRevealRequest}
            onConsumeFileSearchFocusRequest={onConsumeFileSearchFocusRequest}
            onToggleProject={onToggleProject}
            onToggleProjectSessions={onToggleProjectSessions}
            onMountProject={onMountProject}
            onNewAgent={onNewAgent}
            onStartAgent={onStartAgent}
            onOpenProjectMenu={onOpenProjectMenu}
            reorderable={reorderableProjects.filter(candidate => candidate.pinned === project.pinned).length > 1}
            dragging={projectDrag?.agentId === project.id}
            dropPosition={projectDrag?.targetAgentId === project.id ? projectDrag.position : undefined}
            onProjectDragStart={beginProjectDrag}
            onProjectDragEnd={finishProjectDrag}
            onProjectDragOver={(event, projectId) => {
              if (canDropProject(projectId)) updateProjectDropTarget(event, projectId)
            }}
            onProjectDrop={(event, projectId) => {
              if (canDropProject(projectId)) dropProject(event, projectId)
            }}
            onShowProjectPreview={showProjectPreview}
            onOpenAgent={onOpenAgent}
            onUpdateAgentFlags={onUpdateAgentFlags}
            onReorderAgent={onReorderAgent}
            onOpenAgentMenu={onOpenAgentMenu}
            onResumeAgentSession={onResumeAgentSession}
            onOpenAgentSessionMenu={onOpenAgentSessionMenu}
            onToggleAgentSessionPinned={onToggleAgentSessionPinned}
            onArchiveAgentSession={onArchiveAgentSession}
            onShowAgentPreview={showAgentPreview}
            onHideAgentPreview={hideAgentPreview}
            onOpenProjectFile={onOpenProjectFile}
            onBeginProjectFileOpenIntent={onBeginProjectFileOpenIntent}
            onResolveProjectFile={onResolveProjectFile}
            onSelectOpenWorkspaceFile={onSelectOpenWorkspaceFile}
            onCloseOpenWorkspaceFile={onCloseOpenWorkspaceFile}
            onMoveWorkspaceEntries={onMoveWorkspaceEntries}
            onDeleteWorkspaceEntries={onDeleteWorkspaceEntries}
            onRefreshProjectOpenFiles={onRefreshProjectOpenFiles}
            copy={copy}
          />
        ))}
      </div>

      <div className="code-sidebar-footer">
        <div className="code-product-pet-anchor">
          {!sidebarCollapsed && (
            <button
              ref={instanceNameEditRef}
              type="button"
              className="code-instance-name"
              data-testid="code-instance-name-edit"
              aria-label={copy.renameInstance}
              title={instanceName}
              onClick={() => setInstanceNameDialogOpen(true)}
            >
              <span className="code-instance-name-copy">{instanceName}</span>
              <PencilGlyph />
            </button>
          )}
          <FarmingPet
            language={language}
            appearancePreference={appearancePreference}
            restReminderEntryBlocked={
              restReminderEntryBlocked
              || brandDialogOpen
              || instanceNameDialogOpen
              || appModeDialogOpen
            }
          />
          <div className="code-product-row">
            <button
              ref={productMarkRef}
              type="button"
              className="code-product-mark"
              data-testid="code-product-mark"
              title="Farming Code"
              aria-label="Farming Code"
              onClick={() => setBrandDialogOpen(true)}
            >
              <img
                className="code-product-logo"
                src={appPath('/farming-2/app-icon-v2-180.png')}
                alt=""
                aria-hidden="true"
              />
              <span className="code-product-mark-copy">
                <span className="code-product-mark-main-slot">
                  <span className="code-product-mark-main code-product-mark-main-full">Farming Code</span>
                  <span className="code-product-mark-main code-product-mark-main-short" aria-hidden="true">Farming</span>
                </span>
                {currentVersionLabel && (
                  <span className="code-product-mark-badge">{currentVersionLabel}</span>
                )}
              </span>
            </button>
            <button
              type="button"
              className="code-sidebar-options"
              data-testid="code-sidebar-options"
              aria-label={copy.openSettings}
              title={copy.openSettings}
              onClick={onOpenOptionsMenu}
            >
              <SettingsGlyph />
            </button>
          </div>
        </div>
        {!sidebarCollapsed && (
          <UsagePanel
            collapsed={usageCollapsed}
            mainAgent={mainAgent}
            now={now}
            usageSummary={usageSummary}
            agentLaunchOptions={agentLaunchOptions}
            onToggleCollapsed={() => setUsageCollapsed(collapsed => !collapsed)}
            onOpenMainAgent={onOpenMainAgent}
            onRestartMainAgent={onRestartMainAgent}
          />
        )}
      </div>
      {visibleAgentPreview && (
        <AgentHoverPreview
          preview={visibleAgentPreview}
          now={now}
        />
      )}
      {projectPreview && (
        <ProjectHoverPreview preview={projectPreview} copy={copy} />
      )}
      {brandDialogOpen && (
        <BrandAboutDialog
          copy={copy}
          language={language}
          version={currentVersionLabel}
          onClose={closeBrandDialog}
          returnFocusRef={productMarkRef}
        />
      )}
      {instanceNameDialogOpen && (
        <InstanceNameDialog
          copy={copy}
          instanceName={instanceName}
          onClose={closeInstanceNameDialog}
          onSave={onRenameInstance}
          returnFocusRef={instanceNameEditRef}
        />
      )}
      {appModeDialogOpen && (
        <AppModeDialog
          canInstall={Boolean(appInstallPrompt)}
          canFullscreen={focusModeSupported}
          fullscreenActive={focusModeActive}
          installUnavailableReason={installUnavailableReason}
          copy={copy}
          onClose={() => setAppModeDialogOpen(false)}
          onInstall={installApp}
          onToggleFullscreen={toggleFocusModeFromDialog}
        />
      )}
    </aside>
  )
}

function AgentRail({
  items,
  activeTerminalId,
  now,
  onOpenAgent,
  onShowPreview,
  onHidePreview,
  copy,
}: {
  items: SidebarRailItem[]
  activeTerminalId: string | null
  now: number
  onOpenAgent: (agentId: string) => void
  onShowPreview: (event: AgentPreviewAnchorEvent, target: AgentPreviewTarget, compact?: boolean) => void
  onHidePreview: () => void
  copy: CodeCopy
}) {
  return (
    <div className="code-agent-rail" data-testid="code-agent-rail" aria-label={copy.projectsAndAgents}>
      {items.map((item, index) => (
        <AgentRailButton
          key={agentRowKey({ kind: 'agent', agent: item.agent })}
          item={item}
          index={index}
          activeTerminalId={activeTerminalId}
          now={now}
          onOpenAgent={onOpenAgent}
          onShowPreview={onShowPreview}
          onHidePreview={onHidePreview}
        />
      ))}
    </div>
  )
}

function AgentRailButton({
  item,
  index,
  activeTerminalId,
  now,
  onOpenAgent,
  onShowPreview,
  onHidePreview,
}: {
  item: SidebarRailItem
  index: number
  activeTerminalId: string | null
  now: number
  onOpenAgent: (agentId: string) => void
  onShowPreview: (event: AgentPreviewAnchorEvent, target: AgentPreviewTarget, compact?: boolean) => void
  onHidePreview: () => void
}) {
  const backing = { kind: 'agent' as const, agent: item.agent }
  const rowState = buildAgentRowDisplayState(backing, now)
  const active = item.agent.id === activeTerminalId
  const title = [rowState.title, rowState.commandTitle, item.projectName].filter(Boolean).join(' · ')
  const openItem = () => {
    onOpenAgent(item.agent.id)
  }

  return (
    <button
      type="button"
      className={`code-agent-rail-button ${active ? 'active' : ''} ${rowState.unread ? 'unread' : ''}`}
      data-testid="code-agent-rail-item"
      data-agent-id={item.agent.id}
      aria-label={title}
      onClick={openItem}
      onMouseEnter={event => onShowPreview(event, previewTargetForAgent(item.agent, rowState, item.projectName), true)}
      onMouseLeave={onHidePreview}
    >
      <span className="code-agent-rail-label">{index + 1}</span>
      {rowState.statusIndicatorVisible && (
        <span className={`code-agent-rail-status ${rowState.lifecycleStatus} ${rowState.turnActive ? 'turn-active' : ''}`} aria-hidden="true" />
      )}
      {rowState.unread && <span className="code-agent-rail-unread" aria-hidden="true" />}
    </button>
  )
}

function ProjectAgentCompactStrip({
  agents,
  activeTerminalId,
  selectedSearchAgentId,
  claimedAgentSessionKeyByAgentId,
  now,
  onOpenAgent,
  onOpenAgentMenu,
  onShowPreview,
  onHidePreview,
}: {
  agents: Agent[]
  activeTerminalId: string | null
  selectedSearchAgentId: string | null
  claimedAgentSessionKeyByAgentId: ReadonlyMap<string, string>
  now: number
  onOpenAgent: (agentId: string) => void
  onOpenAgentMenu: (event: ContextMenuTriggerEvent, agentId: string) => void
  onShowPreview: (event: AgentPreviewAnchorEvent, target: AgentPreviewTarget, compact?: boolean) => void
  onHidePreview: () => void
}) {
  return (
    <div className="code-project-agent-strip" data-testid="code-project-agent-strip" aria-label="Project agents">
      {agents.map((agent, index) => {
        const rowState = buildAgentRowDisplayState({ kind: 'agent', agent }, now)
        const active = agent.id === activeTerminalId
        const searchSelected = agent.id === selectedSearchAgentId
        const title = rowState.rowTitle || rowState.title
        return (
          <button
            key={agentRowKey({ kind: 'agent', agent, claimedSessionKey: claimedAgentSessionKeyByAgentId.get(agent.id) })}
            type="button"
            className={`code-project-agent-compact ${active ? 'active' : ''} ${searchSelected ? 'search-selected' : ''} ${rowState.unread ? 'unread' : ''}`}
            data-testid="code-project-agent-compact"
            data-agent-id={agent.id}
            aria-label={title}
            onClick={() => onOpenAgent(agent.id)}
            onMouseEnter={event => onShowPreview(event, previewTargetForAgent(agent, rowState), true)}
            onMouseLeave={onHidePreview}
            onContextMenu={event => onOpenAgentMenu(event, agent.id)}
            onKeyDown={event => {
              onOpenAgentMenu(event, agent.id)
              if (event.defaultPrevented) return
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                onOpenAgent(agent.id)
              }
            }}
          >
            <span className="code-project-agent-compact-label">{index + 1}</span>
            {rowState.statusIndicatorVisible && (
              <span className={`code-project-agent-compact-status ${rowState.lifecycleStatus} ${rowState.turnActive ? 'turn-active' : ''}`} aria-hidden="true" />
            )}
            {rowState.unread && <span className="code-project-agent-compact-unread" aria-hidden="true" />}
          </button>
        )
      })}
    </div>
  )
}

function PinnedItemCompactStrip({
  items,
  activeTerminalId,
  selectedSearchAgentId,
  selectedSearchSessionHandle,
  claimedAgentSessionKeyByAgentId,
  now,
  onOpenAgent,
  onOpenAgentMenu,
  onResumeAgentSession,
  onOpenAgentSessionMenu,
  onShowPreview,
  onHidePreview,
}: {
  items: PinnedSidebarItem[]
  activeTerminalId: string | null
  selectedSearchAgentId: string | null
  selectedSearchSessionHandle: string | null
  claimedAgentSessionKeyByAgentId: ReadonlyMap<string, string>
  now: number
  onOpenAgent: (agentId: string) => void
  onOpenAgentMenu: (event: ContextMenuTriggerEvent, agentId: string) => void
  onResumeAgentSession: (provider: string, sessionId: string, providerHomeId?: string) => void
  onOpenAgentSessionMenu: (event: ContextMenuTriggerEvent, provider: string, sessionId: string) => void
  onShowPreview: (event: AgentPreviewAnchorEvent, target: AgentPreviewTarget, compact?: boolean) => void
  onHidePreview: () => void
}) {
  return (
    <div className="code-project-agent-strip code-pinned-agent-strip" data-testid="code-pinned-agent-strip" aria-label="Pinned agents">
      {items.map((item, index) => {
        const rowState = item.kind === 'agent'
          ? buildAgentRowDisplayState({ kind: 'agent', agent: item.agent }, now)
          : buildAgentRowDisplayState({
            kind: 'history',
            session: item.session,
            fallbackTitle: item.session.providerName || item.session.provider || 'Agent',
          }, now)
        const agent = item.kind === 'agent' ? item.agent : null
        const session = item.kind === 'agent' ? null : item.session
        const sessionHandle = session ? agentSessionId(session) : null
        const active = agent ? agent.id === activeTerminalId : false
        const searchSelected = agent
          ? agent.id === selectedSearchAgentId
          : sessionHandle === selectedSearchSessionHandle
        const title = rowState.rowTitle || rowState.title
        return (
          <button
            key={item.kind === 'agent'
              ? agentRowKey({ kind: 'agent', agent: item.agent, claimedSessionKey: claimedAgentSessionKeyByAgentId.get(item.agent.id) })
              : agentRowKey({ kind: 'history', session: item.session })}
            type="button"
            className={`code-project-agent-compact ${active ? 'active' : ''} ${searchSelected ? 'search-selected' : ''} ${rowState.unread ? 'unread' : ''}`}
            data-testid="code-pinned-agent-compact"
            data-agent-id={agent?.id}
            data-session-id={sessionHandle ?? undefined}
            aria-label={title}
            onClick={() => {
              if (agent) {
                onOpenAgent(agent.id)
                return
              }
              if (session) onResumeAgentSession(session.provider, session.id, session.providerHomeId)
            }}
            onMouseEnter={event => onShowPreview(
              event,
              agent
                ? previewTargetForAgent(agent, rowState)
                : previewTargetForSession(session!, rowState),
              true
            )}
            onMouseLeave={onHidePreview}
            onContextMenu={event => {
              if (agent) {
                onOpenAgentMenu(event, agent.id)
                return
              }
              if (session) onOpenAgentSessionMenu(event, session.provider, agentSessionId(session))
            }}
            onKeyDown={event => {
              if (agent) {
                onOpenAgentMenu(event, agent.id)
              } else if (session) {
                onOpenAgentSessionMenu(event, session.provider, agentSessionId(session))
              }
              if (event.defaultPrevented) return
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                if (agent) {
                  onOpenAgent(agent.id)
                } else if (session) {
                  onResumeAgentSession(session.provider, session.id, session.providerHomeId)
                }
              }
            }}
          >
            <span className="code-project-agent-compact-label">{index + 1}</span>
            {rowState.statusIndicatorVisible && (
              <span className={`code-project-agent-compact-status ${rowState.lifecycleStatus} ${rowState.turnActive ? 'turn-active' : ''}`} aria-hidden="true" />
            )}
            {rowState.unread && <span className="code-project-agent-compact-unread" aria-hidden="true" />}
          </button>
        )
      })}
    </div>
  )
}

interface PinnedSectionProps {
  items: PinnedSidebarItem[]
  collapsed: boolean
  compressed: boolean
  dynamicPinningEnabled: boolean
  hasUnread: boolean
  activeTerminalId: string | null
  selectedSearchAgentId: string | null
  selectedSearchSessionHandle: string | null
  claimedAgentSessionKeyByAgentId: ReadonlyMap<string, string>
  agentShortcutKeys: Map<string, string>
  keyboardShortcutsEnabled: boolean
  now: number
  onOpenAgent: (agentId: string) => void
  onUpdateAgentFlags: (agent: Agent, flags: Partial<Pick<Agent, 'followUp' | 'pinned' | 'archived'>>) => void
  onReorderAgent: (agentId: string, beforeAgentId: string, afterAgentId: string) => void
  onOpenAgentMenu: (event: ContextMenuTriggerEvent, agentId: string) => void
  onResumeAgentSession: (provider: string, sessionId: string, providerHomeId?: string) => void
  onOpenAgentSessionMenu: (event: ContextMenuTriggerEvent, provider: string, sessionId: string) => void
  onToggleAgentSessionPinned: (session: AgentSessionHistoryItem) => void
  onArchiveAgentSession: (session: AgentSessionHistoryItem) => void
  onShowAgentPreview: (event: AgentPreviewAnchorEvent, target: AgentPreviewTarget, compact?: boolean) => void
  onHideAgentPreview: () => void
  onToggleCollapsed: () => void
  onToggleDynamicPinning: () => void
  copy: CodeCopy
}

function PinnedSection({
  items,
  collapsed,
  compressed,
  dynamicPinningEnabled,
  hasUnread,
  activeTerminalId,
  selectedSearchAgentId,
  selectedSearchSessionHandle,
  claimedAgentSessionKeyByAgentId,
  agentShortcutKeys,
  keyboardShortcutsEnabled,
  now,
  onOpenAgent,
  onUpdateAgentFlags,
  onReorderAgent,
  onOpenAgentMenu,
  onResumeAgentSession,
  onOpenAgentSessionMenu,
  onToggleAgentSessionPinned,
  onArchiveAgentSession,
  onShowAgentPreview,
  onHideAgentPreview,
  onToggleCollapsed,
  onToggleDynamicPinning,
  copy,
}: PinnedSectionProps) {
  const pinnedAgents = items.flatMap(item => (
    item.kind === 'agent' && !item.dynamicallyPinned ? [item.agent] : []
  ))
  const {
    agentDrag,
    beginAgentDrag,
    dropAgent,
    finishAgentDrag,
    updateAgentDropTarget,
  } = useAgentReorder(pinnedAgents, onReorderAgent, onHideAgentPreview)
  return (
    <section
      className={`code-pinned-section ${collapsed ? 'collapsed' : ''}`}
      data-testid="code-pinned-section"
    >
      <div className="code-pinned-header">
        <button
          type="button"
          className="code-pinned-title"
          data-testid="code-pinned-title"
          aria-expanded={!collapsed}
          onClick={onToggleCollapsed}
        >
          <span className={`code-folder-icon ${collapsed ? 'collapsed' : 'expanded'}`} aria-hidden="true">
            {collapsed ? <ChevronRightGlyph /> : <ChevronDownGlyph />}
          </span>
          <span>{copy.pinned}</span>
        </button>
        <button
          type="button"
          className={`code-pinned-dynamic-toggle ${dynamicPinningEnabled ? 'active' : ''}`}
          data-testid="code-pinned-dynamic-toggle"
          aria-label={copy.dynamicPinning}
          aria-pressed={dynamicPinningEnabled}
          title={copy.dynamicPinning}
          onClick={onToggleDynamicPinning}
        >
          <span className="code-pinned-dynamic-icon" aria-hidden="true">
            <BellGlyph filled={dynamicPinningEnabled} />
          </span>
          {hasUnread && (
            <span
              className="code-pinned-dynamic-unread"
              data-testid="code-pinned-dynamic-unread"
              aria-hidden="true"
            />
          )}
        </button>
      </div>
      {!collapsed && items.length > 0 && (
        <div className="code-agent-list code-pinned-list">
          {compressed ? (
            <PinnedItemCompactStrip
              items={items}
              activeTerminalId={activeTerminalId}
              selectedSearchAgentId={selectedSearchAgentId}
              selectedSearchSessionHandle={selectedSearchSessionHandle}
              claimedAgentSessionKeyByAgentId={claimedAgentSessionKeyByAgentId}
              now={now}
              onOpenAgent={onOpenAgent}
              onOpenAgentMenu={onOpenAgentMenu}
              onResumeAgentSession={onResumeAgentSession}
              onOpenAgentSessionMenu={onOpenAgentSessionMenu}
              onShowPreview={onShowAgentPreview}
              onHidePreview={onHideAgentPreview}
            />
          ) : (
            items.map(item => {
              if (item.kind === 'agent') {
                const agent = item.agent
                const shortcutHint = keyboardShortcutsEnabled ? agentShortcutKeys.get(agent.id) : undefined
                return (
                  <AgentRow
                    key={agentRowKey({ kind: 'agent', agent, claimedSessionKey: claimedAgentSessionKeyByAgentId.get(agent.id) })}
                    agent={agent}
                    shortcutHint={shortcutHint}
                    active={agent.id === activeTerminalId}
                    searchSelected={agent.id === selectedSearchAgentId}
                    now={now}
                    dynamicPinningEnabled={dynamicPinningEnabled}
                    onOpenAgent={onOpenAgent}
                    onUpdateAgentFlags={onUpdateAgentFlags}
                    reorderable={!item.dynamicallyPinned}
                    dragging={agentDrag?.agentId === agent.id}
                    dropPosition={agentDrag?.targetAgentId === agent.id ? agentDrag.position : undefined}
                    onAgentDragStart={beginAgentDrag}
                    onAgentDragEnd={finishAgentDrag}
                    onAgentDragOver={updateAgentDropTarget}
                    onAgentDrop={dropAgent}
                    onOpenAgentMenu={onOpenAgentMenu}
                    onShowPreview={onShowAgentPreview}
                    onHidePreview={onHideAgentPreview}
                    copy={copy}
                  />
                )
              }

              return (
                <AgentRow
                  key={agentRowKey({ kind: 'history', session: item.session })}
                  session={item.session}
                  searchSelected={agentSessionId(item.session) === selectedSearchSessionHandle}
                  now={now}
                  dynamicPinningEnabled={dynamicPinningEnabled}
                  onResume={onResumeAgentSession}
                  onOpenSessionMenu={onOpenAgentSessionMenu}
                  onToggleSessionPinned={onToggleAgentSessionPinned}
                  onArchiveSession={onArchiveAgentSession}
                  onShowPreview={onShowAgentPreview}
                  onHidePreview={onHideAgentPreview}
                  copy={copy}
                />
              )
            })
          )}
        </div>
      )}
    </section>
  )
}

interface ProjectWorktreePopoverProps {
  agentId: string
  anchorRef: RefObject<HTMLButtonElement | null>
  copy: CodeCopy
  fallback: WorkspaceGitWorktrees
  hasDirtyEditors: boolean
  point: { x: number; y: number }
  onClose: () => void
  onMountProject: (workspace: string) => void
  onRepositoryWorktreesChange: (worktrees: WorkspaceGitWorktrees) => void
  onBranchSwitched: () => void
}

function worktreeDisplayName(item: WorkspaceGitWorktree, copy: CodeCopy) {
  if (item.branch) return item.branch
  if (item.detached) return `${copy.worktreeDetached}@${item.head.slice(0, 7)}`
  return item.bare ? 'bare' : item.head.slice(0, 7)
}

function branchSwitchRequestId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `branch-switch-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function branchBlockedMessage(branches: WorkspaceGitBranches, copy: CodeCopy) {
  switch (branches.blockedReasonCode) {
    case 'not-git-repository':
      return copy.gitHistoryNotRepository
    case 'not-main-worktree':
      return copy.branchBlockedNotMainWorktree
    case 'dirty-worktree':
      return copy.branchBlockedDirtyWorktree(branches.dirtyCount)
    case 'active-agents':
      return copy.branchBlockedActiveAgents
    case 'pending-agent-starts':
      return copy.branchBlockedPendingStarts
    case 'no-switchable-branch':
      return copy.branchBlockedNoSwitchableBranch
    default:
      return branches.blockedReason
  }
}

function branchSwitchErrorDetails(error: unknown) {
  if (!(error instanceof WorkspaceFileApiError) || !error.details || typeof error.details !== 'object') {
    return null
  }
  return error.details as Partial<WorkspaceGitBranchSwitchResult>
}

export function ProjectWorktreePopover({
  agentId,
  anchorRef,
  copy,
  fallback,
  hasDirtyEditors,
  point,
  onClose,
  onMountProject,
  onRepositoryWorktreesChange,
  onBranchSwitched,
}: ProjectWorktreePopoverProps) {
  const popoverRef = useRef<HTMLDivElement | null>(null)
  const requestControllerRef = useRef<AbortController | null>(null)
  const switchControllerRef = useRef<AbortController | null>(null)
  const requestGenerationRef = useRef(0)
  const mountedRef = useRef(true)
  const [worktrees, setWorktrees] = useState(fallback)
  const [branches, setBranches] = useState<WorkspaceGitBranches | null>(null)
  const [loading, setLoading] = useState(false)
  const [worktreeError, setWorktreeError] = useState('')
  const [branchError, setBranchError] = useState('')
  const [branchStatus, setBranchStatus] = useState<{ kind: 'success' | 'error'; message: string } | null>(null)
  const [branchInventoryTrusted, setBranchInventoryTrusted] = useState(false)
  const [switchingBranch, setSwitchingBranch] = useState('')

  const loadRepositoryState = useCallback(() => {
    const generation = requestGenerationRef.current + 1
    requestGenerationRef.current = generation
    requestControllerRef.current?.abort()
    const controller = new AbortController()
    requestControllerRef.current = controller
    setLoading(true)
    setWorktreeError('')
    setBranchError('')
    setBranchStatus(null)
    setBranchInventoryTrusted(false)
    setBranches(null)
    void Promise.allSettled([
      fetchWorkspaceGitWorktrees(agentId, { signal: controller.signal }),
      fetchWorkspaceGitBranches(agentId, { signal: controller.signal }),
    ]).then(([worktreeResult, branchResult]) => {
      if (controller.signal.aborted || requestGenerationRef.current !== generation) return
      if (worktreeResult.status === 'fulfilled') {
        setWorktrees(worktreeResult.value)
        onRepositoryWorktreesChange(worktreeResult.value)
      } else {
        setWorktreeError(copy.worktreeLoadFailed)
      }
      if (branchResult.status === 'fulfilled') {
        setBranches(branchResult.value)
        setBranchInventoryTrusted(true)
      } else {
        setBranchError(copy.branchLoadFailed)
      }
    }).finally(() => {
      if (!controller.signal.aborted && requestGenerationRef.current === generation) setLoading(false)
    })
  }, [agentId, copy.branchLoadFailed, copy.worktreeLoadFailed, onRepositoryWorktreesChange])

  useEffect(() => {
    mountedRef.current = true
    loadRepositoryState()
    return () => {
      mountedRef.current = false
      requestGenerationRef.current += 1
      requestControllerRef.current?.abort()
      switchControllerRef.current?.abort()
    }
  }, [loadRepositoryState])

  useDismissiblePopover(!switchingBranch, popoverRef, anchorRef, onClose)

  const switchBranch = async (item: WorkspaceGitBranch) => {
    if (!branches || !branchInventoryTrusted || switchingBranch || item.current || !branches.canSwitch || hasDirtyEditors) return
    if (item.checkedOutWorkspace && item.checkedOutWorkspace !== branches.workspace) return
    const generation = requestGenerationRef.current + 1
    requestGenerationRef.current = generation
    requestControllerRef.current?.abort()
    switchControllerRef.current?.abort()
    const controller = new AbortController()
    switchControllerRef.current = controller
    const timeoutId = window.setTimeout(() => controller.abort(), BRANCH_SWITCH_CLIENT_TIMEOUT_MS)
    setSwitchingBranch(item.name)
    setBranchError('')
    setBranchStatus(null)
    try {
      const result = await switchWorkspaceGitBranch(
        agentId,
        item.name,
        branches.currentBranch,
        branches.head,
        branchSwitchRequestId(),
        { signal: controller.signal },
      )
      if (mountedRef.current && requestGenerationRef.current === generation) {
        setBranches(result)
        setBranchInventoryTrusted(true)
        setBranchStatus({ kind: 'success', message: copy.branchSwitchSucceeded(item.name) })
      }
      try {
        const nextWorktrees = await fetchWorkspaceGitWorktrees(agentId, { signal: controller.signal })
        if (mountedRef.current && requestGenerationRef.current === generation) {
          setWorktrees(nextWorktrees)
          onRepositoryWorktreesChange(nextWorktrees)
        }
      } catch {
        if (mountedRef.current) setWorktreeError(copy.worktreeLoadFailed)
      }
      if (mountedRef.current && requestGenerationRef.current === generation) onBranchSwitched()
    } catch (error) {
      const details = branchSwitchErrorDetails(error)
      const hasFreshInventory = Boolean(
        details?.items
        && typeof details.currentBranch === 'string'
        && typeof details.head === 'string',
      )
      const uncertain = controller.signal.aborted || details?.uncertain === true || !hasFreshInventory
      if (hasFreshInventory && mountedRef.current && requestGenerationRef.current === generation) {
        setBranches(details as WorkspaceGitBranches)
      }
      if (mountedRef.current && requestGenerationRef.current === generation) {
        setBranchInventoryTrusted(!uncertain)
        if (!uncertain && details?.blockedReasonCode) {
          setBranchStatus(null)
        } else {
          const stateChanged = Boolean(
            hasFreshInventory
            && details
            && typeof details.currentBranch === 'string'
            && typeof details.head === 'string'
            && (
              details.currentBranch !== branches.currentBranch
              || details.head !== branches.head
            ),
          )
          const target = details?.items?.find(branch => branch.name === item.name)
          const occupiedWorkspace = target?.checkedOutWorkspace
            && target.checkedOutWorkspace !== details?.workspace
            ? target.checkedOutWorkspace
            : ''
          const message = uncertain
            ? copy.branchSwitchUncertain
            : stateChanged
              ? copy.branchStateChanged
              : occupiedWorkspace
                ? copy.branchCheckedOutElsewhere(occupiedWorkspace)
                : error instanceof Error ? error.message : copy.branchSwitchFailed
          setBranchStatus({ kind: 'error', message })
        }
      }
    } finally {
      window.clearTimeout(timeoutId)
      if (switchControllerRef.current === controller) switchControllerRef.current = null
      if (mountedRef.current && requestGenerationRef.current === generation) setSwitchingBranch('')
    }
  }

  return (
    <div
      ref={popoverRef}
      className="code-worktree-popover"
      data-testid="code-project-worktree-menu"
      role="dialog"
      aria-label={copy.worktrees}
      style={{ left: point.x, top: point.y }}
    >
      <div className="code-worktree-popover-header">
        <span>{copy.worktrees}</span>
        <span className="code-worktree-popover-count">{worktrees.items.length}</span>
        <button
          type="button"
          className={loading ? 'loading' : ''}
          disabled={loading || Boolean(switchingBranch)}
          onClick={loadRepositoryState}
        >
          {copy.refresh}
        </button>
      </div>
      {worktreeError && <div className="code-worktree-popover-status error">{worktreeError}</div>}
      {!worktreeError && !worktrees.isGitRepo && (
        <div className="code-worktree-popover-status">{copy.gitHistoryNotRepository}</div>
      )}
      <div className="code-worktree-list">
        {worktrees.items.map(item => (
          <button
            type="button"
            key={item.workspace}
            className={`code-worktree-row ${item.current ? 'current' : ''}`}
            data-current={item.current ? 'true' : undefined}
            data-main={item.main ? 'true' : undefined}
            title={item.workspace}
            onClick={() => {
              onMountProject(item.workspace)
              onClose()
            }}
          >
            <span className="code-worktree-row-marker" aria-hidden="true" />
            <span className="code-worktree-row-content">
              <span className="code-worktree-row-heading">
                <strong>{worktreeDisplayName(item, copy)}</strong>
                <span className="code-worktree-row-badges">
                  {item.current && <span>{copy.worktreeCurrent}</span>}
                  {item.main && <span>{copy.worktreeMain}</span>}
                  {item.locked && <span title={item.lockReason}>{copy.worktreeLocked}</span>}
                  {item.prunable && <span title={item.pruneReason}>{copy.worktreePrunable}</span>}
                </span>
                {item.head && <code>{item.head.slice(0, 7)}</code>}
              </span>
              <span className="code-worktree-row-path">{item.workspace}</span>
            </span>
          </button>
        ))}
      </div>
      {(branches?.isGitRepo || branchError) && (
        <section className="code-branch-section" aria-label={copy.branches}>
          <div className="code-worktree-popover-header code-worktree-popover-section-header">
            <span>{copy.branches}</span>
            {branches && <span className="code-worktree-popover-count">{branches.items.length}</span>}
          </div>
          {branchError && <div className="code-worktree-popover-status error">{branchError}</div>}
          {!branchError && branches && (hasDirtyEditors || !branches.canSwitch) && (
            <div className="code-worktree-popover-status">
              {hasDirtyEditors ? copy.branchBlockedDirtyEditors : branchBlockedMessage(branches, copy)}
            </div>
          )}
          {branches?.truncated && (
            <div className="code-worktree-popover-status compact">{copy.branchInventoryTruncated}</div>
          )}
          {switchingBranch && (
            <div className="code-worktree-popover-status compact" role="status" aria-live="polite">
              {copy.branchSwitching}
            </div>
          )}
          {branchStatus && (
            <div
              className={`code-worktree-popover-status compact ${branchStatus.kind}`}
              role={branchStatus.kind === 'error' ? 'alert' : 'status'}
              aria-live={branchStatus.kind === 'error' ? 'assertive' : 'polite'}
            >
              {branchStatus.message}
            </div>
          )}
          {branches && (
            <div className="code-branch-list">
              {branches.items.map(item => {
                const occupiedElsewhere = Boolean(
                  item.checkedOutWorkspace && item.checkedOutWorkspace !== branches.workspace,
                )
                const disabled = Boolean(
                  loading || !branchInventoryTrusted || Boolean(branchError) || Boolean(switchingBranch) || item.current || hasDirtyEditors || !branches.canSwitch || occupiedElsewhere,
                )
                const detail = occupiedElsewhere
                  ? copy.branchCheckedOutElsewhere(item.checkedOutWorkspace)
                  : ''
                return (
                  <button
                    type="button"
                    key={item.name}
                    className={`code-worktree-row code-branch-row ${item.current ? 'current' : ''}`}
                    data-testid={`code-project-branch-${item.name}`}
                    data-current={item.current ? 'true' : undefined}
                    disabled={disabled}
                    title={detail || item.name}
                    onClick={() => void switchBranch(item)}
                  >
                    <span className="code-worktree-row-marker" aria-hidden="true" />
                    <span className="code-worktree-row-content">
                      <span className="code-worktree-row-heading">
                        <strong>{item.name}</strong>
                        <span className="code-worktree-row-badges">
                          {item.current && <span>{copy.worktreeCurrent}</span>}
                        </span>
                        <code>{item.head.slice(0, 7)}</code>
                      </span>
                      {detail && <span className="code-worktree-row-path">{detail}</span>}
                    </span>
                  </button>
                )
              })}
            </div>
          )}
        </section>
      )}
    </div>
  )
}

function agentWorktreeList(worktree: Agent['gitWorktree']): WorkspaceGitWorktrees | null {
  if (!worktree?.workspace) return null
  return {
    isGitRepo: true,
    commonDir: worktree.commonDir,
    currentWorkspace: worktree.workspace,
    mainWorkspace: worktree.mainWorkspace,
    items: Array.isArray(worktree.worktrees) ? worktree.worktrees : [],
  }
}

function currentWorktreeName(worktrees: WorkspaceGitWorktrees | null) {
  const current = worktrees?.isGitRepo ? worktrees.items.find(item => item.current) : null
  if (!current) return ''
  return current.branch || (current.head ? `detached@${current.head.slice(0, 7)}` : '')
}

interface ProjectSectionProps {
  project: ProjectGroup
  readOnly: boolean
  agentInventoryComplete: boolean
  collapsed: boolean
  forceAgentsExpanded: boolean
  compactAgents: boolean
  activeTerminalId: string | null
  selectedSearchAgentId: string | null
  selectedSearchSessionHandle: string | null
  claimedAgentSessionKeyByAgentId: ReadonlyMap<string, string>
  agentShortcutKeys: Map<string, string>
  keyboardShortcutsEnabled: boolean
  now: number
  dynamicallyPinnedAgentIds: ReadonlySet<string>
  openWorkspaceFile: OpenWorkspaceFile | null
  openWorkspaceFiles: OpenWorkspaceFile[]
  agentLaunchOptions: AgentLaunchOption[]
  agentRevealRequest: { agentId: string; requestId: number } | null
  onConsumeAgentRevealRequest: (requestId: number) => boolean
  fileRevealRequest: { agentId: string; path: string; kind: 'directory' | 'file'; requestId: number } | null
  fileSearchFocusRequest: { agentId: string; requestId: number; query?: string } | null
  onConsumeFileRevealRequest: (requestId: number) => boolean
  onConsumeFileSearchFocusRequest: (requestId: number) => boolean
  onToggleProject: (projectId: string) => void
  onToggleProjectSessions: (projectId: string, direction: 'more' | 'less') => void
  onMountProject: (workspace: string) => void
  onNewAgent: (workspace?: string, command?: string, returnFocusTarget?: HTMLElement | null) => void
  onStartAgent: (command: string, workspace: string, options?: { projectWorkspace?: string; agentRuntimeMode?: 'terminal' | 'chat' | 'acp' }) => void
  onOpenProjectMenu: (event: ContextMenuTriggerEvent, projectId: string, protectedAgentIds?: readonly string[]) => void
  reorderable: boolean
  dragging: boolean
  dropPosition?: 'before' | 'after'
  onProjectDragStart: (event: ReactDragEvent<HTMLElement>, projectId: string) => void
  onProjectDragEnd: () => void
  onProjectDragOver: (event: ReactDragEvent<HTMLElement>, projectId: string) => void
  onProjectDrop: (event: ReactDragEvent<HTMLElement>, projectId: string) => void
  onShowProjectPreview: (event: AgentPreviewAnchorEvent, target: ProjectPreviewTarget) => void
  onOpenAgent: (agentId: string) => void
  onUpdateAgentFlags: (agent: Agent, flags: Partial<Pick<Agent, 'followUp' | 'pinned' | 'archived'>>) => void
  onReorderAgent: (agentId: string, beforeAgentId: string, afterAgentId: string) => void
  onOpenAgentMenu: (event: ContextMenuTriggerEvent, agentId: string) => void
  onResumeAgentSession: (provider: string, sessionId: string, providerHomeId?: string) => void
  onOpenAgentSessionMenu: (event: ContextMenuTriggerEvent, provider: string, sessionId: string) => void
  onToggleAgentSessionPinned: (session: AgentSessionHistoryItem) => void
  onArchiveAgentSession: (session: AgentSessionHistoryItem) => void
  onShowAgentPreview: (event: AgentPreviewAnchorEvent, target: AgentPreviewTarget, compact?: boolean) => void
  onHideAgentPreview: () => void
  onOpenProjectFile: (
    agentId: string,
    file: OpenWorkspaceFile['file'],
    target?: WorkspaceFileOpenTarget,
    signal?: AbortSignal,
    intentLease?: RequestOwnershipLease,
  ) => void | Promise<void>
  onBeginProjectFileOpenIntent: () => RequestOwnershipLease
  onResolveProjectFile: (
    rootId: string,
    filePath: string,
    options?: WorkspaceFileResolveOptions,
  ) => Promise<OpenWorkspaceFile['file']>
  onSelectOpenWorkspaceFile: (agentId: string, filePath: string, target?: WorkspaceFileOpenTarget) => boolean
  onCloseOpenWorkspaceFile: (agentId: string, filePath: string, workspaceRoot?: string) => void
  onMoveWorkspaceEntries: (agentId: string, moves: WorkspaceFileMove[]) => void
  onDeleteWorkspaceEntries: (agentId: string, deletions: WorkspaceFileDeleteResult[]) => void
  onRefreshProjectOpenFiles: (filesId: string, workspaceRoot: string) => Promise<boolean>
  copy: CodeCopy
}

function projectHeaderMetrics(
  project: ProjectGroup,
  agentInventoryComplete: boolean,
  liveSummary: ReturnType<typeof projectAgentLiveSummary>,
  now: number,
) {
  const summary = agentInventoryComplete
    ? (project.hasMain ? null : liveSummary)
    : (project.agentSummary ?? null)
  let agentCount = 0
  let activeCount = 0
  let followUpCount = 0
  let unreadCount = 0
  let zombieCount = 0
  let maxAttentionScore = 0

  if (summary) {
    agentCount = summary.agentCount
    activeCount = summary.activeCount
    followUpCount = summary.followUpCount ?? 0
    unreadCount = summary.unreadCount
    zombieCount = summary.zombieCount
    maxAttentionScore = summary.maxAttentionScore
  } else if (
    !agentInventoryComplete
    || project.hasMain
    || project.agents.some(agent => !agent.isMain && agent.archived !== true)
  ) {
    const agents = project.agents
      .filter(agent => !agent.isMain && agent.archived !== true)
      .map(agentWithCurrentLiveState)
    agentCount = agents.length
    activeCount = agents.filter(agent => buildAgentRowDisplayState({
      kind: 'agent',
      agent,
    }, now).turnActive).length
    followUpCount = agents.filter(agent => agent.followUp === true).length
    unreadCount = agents.filter(agent => agent.unread === true).length
    zombieCount = agents.filter(agent => agent.isZombie === true).length
    maxAttentionScore = agents.reduce((maximum, agent) => (
      Math.max(maximum, Number.isFinite(agent.attentionScore) ? agent.attentionScore : 0)
    ), 0)
  }

  const sessions = project.agentSessions.filter(session => session.archived !== true)
  return {
    activeCount,
    agentCount: agentCount + sessions.length + (project.hiddenAgentSessionCount ?? 0),
    followUpCount,
    maxAttentionScore,
    unreadCount: unreadCount + sessions.filter(session => session.unread === true).length,
    zombieCount,
  }
}

function ProjectSection(props: ProjectSectionProps) {
  const { agentInventoryComplete, now, project } = props
  const liveSummary = useProjectAgentLiveSummary(
    agentInventoryComplete && !project.hasMain ? project.workspace : '',
  )
  const metrics = projectHeaderMetrics(project, agentInventoryComplete, liveSummary, now)

  return (
    <section
      className="code-project-group"
      data-testid="code-project-group"
      data-collapsed={props.collapsed ? 'true' : 'false'}
      data-project-agent-count={metrics.agentCount}
      data-project-active-count={metrics.activeCount}
      data-project-follow-up-count={metrics.followUpCount}
      data-project-unread-count={metrics.unreadCount}
      data-project-zombie-count={metrics.zombieCount}
      data-project-max-attention={metrics.maxAttentionScore}
    >
      <ProjectSectionContent {...props} followUpCount={metrics.followUpCount} />
    </section>
  )
}

const ProjectSectionContent = memo(function ProjectSectionContent({
  project,
  readOnly,
  followUpCount,
  agentInventoryComplete,
  collapsed,
  forceAgentsExpanded,
  compactAgents,
  activeTerminalId,
  selectedSearchAgentId,
  selectedSearchSessionHandle,
  claimedAgentSessionKeyByAgentId,
  agentShortcutKeys,
  keyboardShortcutsEnabled,
  now,
  dynamicallyPinnedAgentIds,
  openWorkspaceFile,
  openWorkspaceFiles,
  agentLaunchOptions,
  agentRevealRequest,
  onConsumeAgentRevealRequest,
  fileRevealRequest,
  fileSearchFocusRequest,
  onConsumeFileRevealRequest,
  onConsumeFileSearchFocusRequest,
  onToggleProject,
  onToggleProjectSessions,
  onMountProject,
  onNewAgent,
  onStartAgent,
  onOpenProjectMenu,
  reorderable,
  dragging,
  dropPosition,
  onProjectDragStart,
  onProjectDragEnd,
  onProjectDragOver,
  onProjectDrop,
  onShowProjectPreview,
  onOpenAgent,
  onUpdateAgentFlags,
  onReorderAgent,
  onOpenAgentMenu,
  onResumeAgentSession,
  onOpenAgentSessionMenu,
  onToggleAgentSessionPinned,
  onArchiveAgentSession,
  onShowAgentPreview,
  onHideAgentPreview,
  onOpenProjectFile,
  onBeginProjectFileOpenIntent,
  onResolveProjectFile,
  onSelectOpenWorkspaceFile,
  onCloseOpenWorkspaceFile,
  onMoveWorkspaceEntries,
  onDeleteWorkspaceEntries,
  onRefreshProjectOpenFiles,
  copy,
}: ProjectSectionProps & { followUpCount: number }) {
  recordPerformanceTestRender('projectSectionContent')
  const projectDraggedRef = useRef(false)
  const projectRowRef = useRef<HTMLDivElement | null>(null)
  const agentsSectionRef = useRef<HTMLDivElement | null>(null)
  const launchButtonRef = useRef<HTMLButtonElement | null>(null)
  const launchMenuRef = useRef<HTMLDivElement | null>(null)
  const worktreeButtonRef = useRef<HTMLButtonElement | null>(null)
  const [launchMenu, setLaunchMenu] = useState<{ x: number; y: number } | null>(null)
  const closeLaunchMenu = useCallback(() => setLaunchMenu(null), [])
  const [worktreeMenu, setWorktreeMenu] = useState<{ x: number; y: number } | null>(null)
  const [repositoryWorktrees, setRepositoryWorktrees] = useState<WorkspaceGitWorktrees | null>(() => (
    agentWorktreeList(project.gitWorktree)
  ))
  const [branchSwitchRevision, setBranchSwitchRevision] = useState(0)
  const [initialProjectViewState] = useState(() => loadCodeProjectFilesViewState(project.id))
  const [projectAgentVisibleLimit, setProjectAgentVisibleLimit] = useState(
    initialProjectViewState.agentVisibleLimit ?? PROJECT_AGENT_INITIAL_VISIBLE_LIMIT,
  )
  const [projectAgentsCollapsed, setProjectAgentsCollapsed] = useState(
    initialProjectViewState.agentsCollapsed ?? false,
  )
  const [paginationExcludedAgentIds, setPaginationExcludedAgentIds] = useState<Set<string>>(() => new Set())
  const [projectSourceAgentId, setProjectSourceAgentId] = useState<string | null>(() => (
    stableProjectSourceAgentId(null, project.agents)
  ))
  const activeProjectAgentId = activeTerminalId && project.agents.some(agent => (
    !agent.isMain && agent.id === activeTerminalId
  ))
    ? activeTerminalId
    : null
  const nextProjectSourceAgentId = stableProjectSourceAgentId(
    activeProjectAgentId ?? projectSourceAgentId,
    project.agents,
  )
  const projectSourceAgent = project.agents.find(agent => (
    !agent.isMain && agent.id === nextProjectSourceAgentId
  )) ?? null
  const filesWorkspaceId = project.workspace ? projectFilesWorkspaceId(project.workspace) : ''
  const showProjectFiles = project.id !== MAIN_AGENT_PROJECT_ID && Boolean(filesWorkspaceId)
  const globalRootProject = filesWorkspaceId === GLOBAL_WORKSPACE_FILES_AGENT_ID
  const projectFileContextIds = new Set([
    filesWorkspaceId,
    ...project.agents.filter(agent => !agent.isMain).map(agent => agent.id),
    ...(projectSourceAgent && !projectSourceAgent.isMain ? [projectSourceAgent.id] : []),
  ])
  const openFileBelongsToProject = (file: OpenWorkspaceFile) => (
    file.workspaceRoot === project.workspace || projectFileContextIds.has(file.agentId)
  )
  const activeProjectFile = openWorkspaceFile && openFileBelongsToProject(openWorkspaceFile)
    ? openWorkspaceFile
    : null
  const projectOpenWorkspaceFiles = openWorkspaceFiles.filter(openFileBelongsToProject)
  const projectEditorDirtyFilePaths = new Set(
    projectOpenWorkspaceFiles.filter(file => file.dirty).map(file => file.file.path)
  )
  const projectEditorExternalChangedFilePaths = new Set(
    projectOpenWorkspaceFiles.filter(file => file.externalChanged).map(file => file.file.path)
  )
  const sortedAgents = project.agents.filter(agent => (
    !agent.pinned && !dynamicallyPinnedAgentIds.has(agent.id)
  ))
  const lastProjectAgentId = sortedAgents[sortedAgents.length - 1]?.id ?? ''
  const visibleAgentSessions = project.agentSessions.filter(session => !session.pinned)
  const pinnedSectionAgentIds = project.agents
    .filter(agent => agent.pinned || dynamicallyPinnedAgentIds.has(agent.id))
    .map(agent => agent.id)
  const showAgentsSection = sortedAgents.length > 0 || visibleAgentSessions.length > 0 || (project.hiddenAgentSessionCount ?? 0) > 0
  const compactProjectAgents = compactAgents && sortedAgents.length > 0
  const visibleProjectAgents = compactProjectAgents
    ? sortedAgents
    : visibleAgentsWithForcedRows(
      sortedAgents,
      projectAgentVisibleLimit,
      [activeTerminalId, selectedSearchAgentId],
      paginationExcludedAgentIds,
    )
  const hiddenProjectAgentCount = Math.max(0, sortedAgents.length - visibleProjectAgents.length)
  const projectAgentRevealCount = Math.min(
    hiddenProjectAgentCount,
    projectAgentVisibleLimit === PROJECT_AGENT_INITIAL_VISIBLE_LIMIT
      ? PROJECT_AGENT_FIRST_REVEAL_COUNT
      : PROJECT_AGENT_NEXT_REVEAL_COUNT,
  )
  const projectAgentsExpanded = projectAgentVisibleLimit > PROJECT_AGENT_INITIAL_VISIBLE_LIMIT
  const agentListCollapsed = projectAgentsCollapsed && !forceAgentsExpanded
  const canRevealProjectAgents = !forceAgentsExpanded && !compactProjectAgents && hiddenProjectAgentCount > 0
  const canRevealProjectSessions = !canRevealProjectAgents && (project.hiddenAgentSessionCount ?? 0) > 0
  const canCollapseProjectRows = (
    (!forceAgentsExpanded && !compactProjectAgents && projectAgentsExpanded)
    || project.agentSessionsExpanded === true
  )
  const requestedAgentBelongsToProject = Boolean(
    agentRevealRequest && project.agents.some(agent => (
      agent.id === agentRevealRequest.agentId
      && !agent.pinned
      && !dynamicallyPinnedAgentIds.has(agent.id)
    )),
  )

  useEffect(() => {
    if (
      !agentRevealRequest
      || !requestedAgentBelongsToProject
      || !onConsumeAgentRevealRequest(agentRevealRequest.requestId)
    ) return
    setProjectAgentsCollapsed(false)
  }, [agentRevealRequest, onConsumeAgentRevealRequest, requestedAgentBelongsToProject])

  useEffect(() => {
    saveCodeProjectFilesViewState(project.id, { agentsCollapsed: projectAgentsCollapsed })
  }, [project.id, projectAgentsCollapsed])

  useEffect(() => {
    saveCodeProjectFilesViewState(project.id, { agentVisibleLimit: projectAgentVisibleLimit })
  }, [project.id, projectAgentVisibleLimit])

  useEffect(() => {
    if (projectSourceAgentId !== nextProjectSourceAgentId) {
      setProjectSourceAgentId(nextProjectSourceAgentId)
    }
  }, [nextProjectSourceAgentId, projectSourceAgentId])

  useEffect(() => {
    const agentWorktrees = agentWorktreeList(project.gitWorktree)
    if (agentWorktrees) setRepositoryWorktrees(agentWorktrees)
  }, [project.gitWorktree])

  useEffect(() => {
    if (!filesWorkspaceId || globalRootProject) return
    const controller = new AbortController()
    void fetchWorkspaceGitWorktrees(filesWorkspaceId, { signal: controller.signal })
      .then(setRepositoryWorktrees)
      .catch(() => {})
    return () => controller.abort()
  }, [filesWorkspaceId, globalRootProject])

  const withProjectSourceAgent = useCallback((target?: WorkspaceFileOpenTarget) => {
    if (!projectSourceAgent?.id || target?.sourceAgentId) return target
    const contextualTarget = target ?? {}
    // Project file opens keep this target object stable while a pending read is
    // upgraded (for example preview to pinned). Preserve that identity here.
    contextualTarget.sourceAgentId = projectSourceAgent.id
    return contextualTarget
  }, [projectSourceAgent?.id])

  const openProjectWorkspaceFile = useCallback((
    filesId: string,
    file: OpenWorkspaceFile['file'],
    target?: WorkspaceFileOpenTarget,
    signal?: AbortSignal,
    intentLease?: RequestOwnershipLease,
  ) => {
    return onOpenProjectFile(filesId, file, withProjectSourceAgent(target), signal, intentLease)
  }, [onOpenProjectFile, withProjectSourceAgent])

  const selectOpenProjectWorkspaceFile = useCallback((filesId: string, filePath: string, target?: WorkspaceFileOpenTarget) => (
    onSelectOpenWorkspaceFile(filesId, filePath, withProjectSourceAgent(target))
  ), [onSelectOpenWorkspaceFile, withProjectSourceAgent])

  const {
    agentDrag,
    beginAgentDrag,
    dropAgent,
    dropAgentAtEnd,
    droppingAtEnd: droppingAtProjectEnd,
    finishAgentDrag,
    updateAgentDropTarget,
    updateAgentEndDropTarget: updateProjectEndDropTarget,
  } = useAgentReorder(sortedAgents, onReorderAgent, onHideAgentPreview)
  const dropAgentAtProjectEnd = useCallback((event: ReactDragEvent<HTMLElement>) => {
    const droppedAgentId = agentDrag?.agentId
    dropAgentAtEnd(event)
    if (!droppedAgentId) return
    setPaginationExcludedAgentIds(current => new Set([...current, droppedAgentId]))
  }, [agentDrag?.agentId, dropAgentAtEnd])

  useEffect(() => {
    setProjectAgentVisibleLimit(current => {
      const next = Math.max(PROJECT_AGENT_INITIAL_VISIBLE_LIMIT, Math.min(current, sortedAgents.length))
      return next === current ? current : next
    })
  }, [sortedAgents.length])

  useEffect(() => {
    if (!lastProjectAgentId) return
    setPaginationExcludedAgentIds(current => {
      if (!current.has(lastProjectAgentId)) return current
      const next = new Set(current)
      next.delete(lastProjectAgentId)
      return next
    })
  }, [lastProjectAgentId])

  useLayoutEffect(() => {
    const projectGroup = projectRowRef.current?.closest<HTMLElement>('.code-project-group')
    if (!projectGroup) return

    const visibleStickyHeight = (element: HTMLElement | null) => {
      if (!element) return 0
      const style = getComputedStyle(element)
      return Math.max(0, element.getBoundingClientRect().height - Number.parseFloat(style.paddingBottom || '0'))
    }
    const setStickyMetrics = () => {
      const projectRow = projectRowRef.current
      projectGroup.style.setProperty(
        '--code-project-sticky-height',
        projectRow ? `${Math.ceil(visibleStickyHeight(projectRow))}px` : '',
      )
      const agentsSection = agentsSectionRef.current
      projectGroup.style.setProperty(
        '--code-agents-sticky-height',
        agentsSection ? `${Math.ceil(visibleStickyHeight(agentsSection))}px` : '0px',
      )
    }

    setStickyMetrics()
    const projectRow = projectRowRef.current
    const agentsSection = agentsSectionRef.current
    const observer = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(setStickyMetrics)
      : null
    if (projectRow) {
      observer?.observe(projectRow)
    }
    if (agentsSection) {
      observer?.observe(agentsSection)
    }
    window.addEventListener('resize', setStickyMetrics)

    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', setStickyMetrics)
    }
  }, [
    agentListCollapsed,
    collapsed,
    compactProjectAgents,
    hiddenProjectAgentCount,
    project.agentSessionsExpanded,
    project.hiddenAgentSessionCount,
    project.id,
    projectAgentsExpanded,
    showAgentsSection,
    visibleAgentSessions.length,
    visibleProjectAgents.length,
  ])

  useDismissiblePopover(
    launchMenu !== null,
    launchMenuRef,
    launchButtonRef,
    closeLaunchMenu,
  )

  const openProjectLaunchMenu = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.preventDefault()
    event.stopPropagation()
    if (agentLaunchOptions.length === 0) {
      onNewAgent(project.workspace, undefined, event.currentTarget)
      return
    }

    const rect = event.currentTarget.getBoundingClientRect()
    const compact = isCompactViewport()
    const menuWidth = compact ? 190 : 194
    const menuHeight = Math.min(260, agentLaunchOptions.length * 34 + 12)
    const point = compact
      ? mobileActionMenuPoint(rect, menuHeight, undefined, menuWidth)
      : outwardContextMenuPoint(rect, menuHeight, undefined, menuWidth)
    setLaunchMenu(point)
  }

  const startProjectAgent = (command: string, agentRuntimeMode?: 'chat') => {
    setLaunchMenu(null)
    onStartAgent(command, project.workspace, agentRuntimeMode ? { agentRuntimeMode } : undefined)
  }
  const currentProjectWorktreeName = currentWorktreeName(repositoryWorktrees)
  const repositoryWorktreeCount = repositoryWorktrees?.items.length || 0
  const openWorktreeMenu = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.preventDefault()
    event.stopPropagation()
    const rect = event.currentTarget.getBoundingClientRect()
    const menuWidth = Math.min(440, Math.max(320, window.innerWidth - 24))
    const menuHeight = 420
    const point = isCompactViewport()
      ? mobileActionMenuPoint(rect, menuHeight, undefined, menuWidth)
      : outwardContextMenuPoint(rect, menuHeight, undefined, menuWidth)
    setWorktreeMenu(point)
  }

  return (
    <>
      <div
        ref={projectRowRef}
        className={`code-project-row ${dragging ? 'dragging' : ''} ${dropPosition ? `drop-${dropPosition}` : ''}`}
        onDragOver={event => onProjectDragOver(event, project.id)}
        onDrop={event => onProjectDrop(event, project.id)}
        onMouseEnter={event => {
          const currentSummary = agentInventoryComplete && !project.hasMain
            ? projectAgentLiveSummary(project.workspace)
            : null
          const metrics = projectHeaderMetrics(
            project,
            agentInventoryComplete,
            currentSummary,
            now,
          )
          onShowProjectPreview(event, {
            key: `project:${project.id}`,
            name: project.name,
            workspace: project.workspace,
            agentCount: metrics.agentCount,
            unreadCount: metrics.unreadCount,
            runningCount: metrics.activeCount,
            branch: currentProjectWorktreeName,
            worktreeCount: repositoryWorktreeCount,
            pinned: project.pinned === true,
          })
        }}
        onMouseLeave={onHideAgentPreview}
      >
        <span className="code-project-title-content">
          <button
            type="button"
            className="code-project-title"
            data-testid="code-project-title"
            data-project-id={project.id}
            draggable={(reorderable && !isTouchInputViewport()) || undefined}
            aria-expanded={!collapsed}
            onDragStart={event => {
              if (!reorderable) return
              projectDraggedRef.current = true
              onProjectDragStart(event, project.id)
            }}
            onDragEnd={() => {
              onProjectDragEnd()
              window.setTimeout(() => {
                projectDraggedRef.current = false
              }, 0)
            }}
            onClick={event => {
              if (projectDraggedRef.current) {
                event.preventDefault()
                event.stopPropagation()
                return
              }
              onToggleProject(project.id)
            }}
            onContextMenu={event => onOpenProjectMenu(event, project.id, pinnedSectionAgentIds)}
            onKeyDown={event => onOpenProjectMenu(event, project.id, pinnedSectionAgentIds)}
          >
            <span className={`code-folder-icon ${collapsed ? 'collapsed' : 'expanded'}`} aria-hidden="true">
              {collapsed ? <ChevronRightGlyph /> : <ChevronDownGlyph />}
            </span>
            <span className="code-project-title-name">{project.name}</span>
            {followUpCount > 0 && (
              <span
                className="code-project-follow-up-count"
                data-testid="code-project-follow-up-count"
                title={`${copy.followUp}: ${followUpCount}`}
              >
                <FieldFlagGlyph filled />
                <span>{followUpCount}</span>
              </span>
            )}
          </button>
          {currentProjectWorktreeName && repositoryWorktrees && (
            <button
              ref={worktreeButtonRef}
              type="button"
              className="code-project-worktree"
              data-testid="code-project-worktree"
              aria-label={`${currentProjectWorktreeName} · ${repositoryWorktreeCount} ${copy.worktrees}`}
              aria-haspopup="dialog"
              aria-expanded={worktreeMenu ? true : undefined}
              onClick={openWorktreeMenu}
            >
              <span className="code-project-worktree-icon" aria-hidden="true"><BranchGlyph /></span>
              <span className="code-project-worktree-name">{currentProjectWorktreeName}</span>
              {repositoryWorktreeCount > 1 && (
                <span className="code-project-worktree-count" aria-hidden="true">{repositoryWorktreeCount}</span>
              )}
            </button>
          )}
        </span>
        <span className="code-project-title-actions" aria-hidden={false}>
          {showAgentsSection && !forceAgentsExpanded && (
            <button
              type="button"
              className="code-project-title-action"
              data-testid="code-project-agent-visibility"
              data-collapsed={agentListCollapsed ? 'true' : 'false'}
              aria-expanded={!agentListCollapsed}
              aria-label={agentListCollapsed ? copy.showAgents : copy.hideAgents}
              title={agentListCollapsed ? copy.showAgents : copy.hideAgents}
              onClick={() => setProjectAgentsCollapsed(collapsed => !collapsed)}
            >
              {agentListCollapsed ? <VisibilityGlyph /> : <VisibilityOffGlyph />}
            </button>
          )}
          <button
            type="button"
            className="code-project-title-action"
            data-testid="code-project-actions"
            aria-label={copy.openOptions}
            title={copy.openOptions}
            onClick={event => onOpenProjectMenu(event, project.id, pinnedSectionAgentIds)}
          >
            <ProjectActionsIcon />
          </button>
          {!globalRootProject && (
            <button
              ref={launchButtonRef}
              type="button"
              className="code-project-title-action"
              data-testid="code-project-new-agent"
              aria-label={copy.newAgent}
              title={copy.newAgent}
              aria-haspopup="menu"
              aria-expanded={launchMenu ? true : undefined}
              onClick={openProjectLaunchMenu}
            >
              <ProjectNewAgentIcon />
            </button>
          )}
        </span>
        {launchMenu && typeof document !== 'undefined' && createPortal(
          <div
            ref={launchMenuRef}
            className="code-context-menu code-project-launch-menu"
            data-testid="code-project-new-agent-menu"
            role="menu"
            style={{ left: launchMenu.x, top: launchMenu.y }}
          >
            {agentLaunchOptions.map(option => {
              const command = option.command || option.name
              const displayName = agentDisplayName(option.name)
              const supportsChat = option.capabilities?.supportsChat === true
              return (
                <div
                  key={option.name}
                  className={`code-project-launch-option ${supportsChat ? 'has-chat' : ''}`}
                  role="none"
                >
                  <button
                    type="button"
                    role="menuitem"
                    className="code-project-agent-launch"
                    data-testid={`code-project-agent-launch-${option.name}`}
                    onClick={() => startProjectAgent(command)}
                  >
                    <AgentLaunchIcon name={option.name} />
                    <span>{displayName}</span>
                  </button>
                  {supportsChat && (
                    <button
                      type="button"
                      role="menuitem"
                      className="code-project-agent-launch-chat"
                      data-testid={`code-project-agent-launch-chat-${option.name}`}
                      aria-label={`${displayName} · ${copy.transcriptView}`}
                      title={copy.transcriptView}
                      onClick={() => startProjectAgent(command, 'chat')}
                    >
                      <ChatBubblesGlyph />
                    </button>
                  )}
                </div>
              )
            })}
          </div>,
          document.body
        )}
        {worktreeMenu && repositoryWorktrees && typeof document !== 'undefined' && createPortal(
          <ProjectWorktreePopover
            agentId={filesWorkspaceId}
            anchorRef={worktreeButtonRef}
            copy={copy}
            fallback={repositoryWorktrees}
            hasDirtyEditors={projectEditorDirtyFilePaths.size > 0}
            point={worktreeMenu}
            onClose={() => setWorktreeMenu(null)}
            onMountProject={onMountProject}
            onRepositoryWorktreesChange={setRepositoryWorktrees}
            onBranchSwitched={() => setBranchSwitchRevision(revision => revision + 1)}
          />,
          document.body
        )}
      </div>
      {!collapsed && (
        <div className="code-project-expanded">
          {showAgentsSection && (
            <div ref={agentsSectionRef} className="code-agents-section" data-testid="code-agents-section" data-project-id={project.id}>
              <div className="code-agent-list">
                {!agentListCollapsed && (
                  <>
                    {compactProjectAgents ? (
                      <ProjectAgentCompactStrip
                        agents={sortedAgents}
                        activeTerminalId={activeTerminalId}
                        selectedSearchAgentId={selectedSearchAgentId}
                        claimedAgentSessionKeyByAgentId={claimedAgentSessionKeyByAgentId}
                        now={now}
                        onOpenAgent={onOpenAgent}
                        onOpenAgentMenu={onOpenAgentMenu}
                        onShowPreview={onShowAgentPreview}
                        onHidePreview={onHideAgentPreview}
                      />
                    ) : (
                      visibleProjectAgents.map(agent => {
                        const shortcutHint = keyboardShortcutsEnabled ? agentShortcutKeys.get(agent.id) : undefined
                        return (
                          <AgentRow
                            key={agentRowKey({ kind: 'agent', agent, claimedSessionKey: claimedAgentSessionKeyByAgentId.get(agent.id) })}
                            agent={agent}
                            shortcutHint={shortcutHint}
                            active={agent.id === activeTerminalId}
                            searchSelected={agent.id === selectedSearchAgentId}
                            now={now}
                            onOpenAgent={onOpenAgent}
                            onUpdateAgentFlags={onUpdateAgentFlags}
                            reorderable
                            dragging={agentDrag?.agentId === agent.id}
                            dropPosition={agentDrag?.targetAgentId === agent.id ? agentDrag.position : undefined}
                            onAgentDragStart={beginAgentDrag}
                            onAgentDragEnd={finishAgentDrag}
                            onAgentDragOver={updateAgentDropTarget}
                            onAgentDrop={dropAgent}
                            onOpenAgentMenu={onOpenAgentMenu}
                            onShowPreview={onShowAgentPreview}
                            onHidePreview={onHideAgentPreview}
                            copy={copy}
                          />
                        )
                      })
                    )}
                    {visibleAgentSessions.map(session => (
                      <AgentRow
                        key={agentRowKey({ kind: 'history', session })}
                        session={session}
                        searchSelected={agentSessionId(session) === selectedSearchSessionHandle}
                        now={now}
                        onResume={onResumeAgentSession}
                        onOpenSessionMenu={onOpenAgentSessionMenu}
                        onToggleSessionPinned={onToggleAgentSessionPinned}
                        onArchiveSession={onArchiveAgentSession}
                        onShowPreview={onShowAgentPreview}
                        onHidePreview={onHideAgentPreview}
                        copy={copy}
                      />
                    ))}
                  </>
                )}
                {!agentListCollapsed && (canRevealProjectAgents || canRevealProjectSessions || canCollapseProjectRows) && (
                  <div
                    className="code-agent-list-controls"
                    data-testid="code-agent-list-controls"
                  >
                    {(canRevealProjectAgents || canRevealProjectSessions) && (
                      <button
                        type="button"
                        className={`code-agent-row code-session-show-more ${droppingAtProjectEnd ? 'drop-after' : ''}`}
                        data-testid={canRevealProjectAgents ? 'code-agent-show-more' : 'code-session-show-more'}
                        aria-label={canRevealProjectAgents
                          ? copy.showMoreAgents(projectAgentRevealCount)
                          : copy.showMoreAgentSessions(project.agentSessionRevealCount ?? 0)}
                        onClick={() => {
                          if (canRevealProjectAgents) {
                            setProjectAgentVisibleLimit(current => Math.min(
                              sortedAgents.length,
                              current + (
                                current === PROJECT_AGENT_INITIAL_VISIBLE_LIMIT
                                  ? PROJECT_AGENT_FIRST_REVEAL_COUNT
                                  : PROJECT_AGENT_NEXT_REVEAL_COUNT
                              ),
                            ))
                            return
                          }
                          onToggleProjectSessions(project.id, 'more')
                        }}
                        onDragOver={canRevealProjectAgents ? updateProjectEndDropTarget : undefined}
                        onDrop={canRevealProjectAgents ? dropAgentAtProjectEnd : undefined}
                      >
                        <span className="code-agent-row-copy">
                          <span className="code-agent-name">{copy.showMore}</span>
                        </span>
                        <span className="code-agent-row-trailing">
                          <span className="code-agent-age">
                            {canRevealProjectAgents ? projectAgentRevealCount : project.agentSessionRevealCount}
                          </span>
                        </span>
                      </button>
                    )}
                    {canCollapseProjectRows && (
                      <button
                        type="button"
                        className="code-agent-row code-session-show-more"
                        data-testid={project.agentSessionsExpanded ? 'code-session-show-less' : 'code-agent-show-less'}
                        onClick={() => {
                          if (projectAgentsExpanded) setProjectAgentVisibleLimit(PROJECT_AGENT_INITIAL_VISIBLE_LIMIT)
                          if (project.agentSessionsExpanded) onToggleProjectSessions(project.id, 'less')
                        }}
                      >
                        <span className="code-agent-row-copy">
                          <span className="code-agent-name">{copy.showLess}</span>
                        </span>
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
          <div
            className="code-project-resource-slot"
            data-testid="code-project-resource-slot"
            data-project-id={project.id}
          />
          {showProjectFiles && (
            <Suspense fallback={null}>
              <ProjectFilesSection
                projectId={project.id}
                projectWorkspace={project.workspace}
                agentId={filesWorkspaceId}
                agentLaunchOptions={agentLaunchOptions}
                activeFilePath={activeProjectFile?.file.path}
                activeFileRevealInTree={activeProjectFile?.revealInTree}
                openFiles={projectOpenWorkspaceFiles
                  .map(file => ({
                    agentId: file.agentId,
                    workspaceRoot: file.workspaceRoot,
                    key: workspaceOpenFileKey(file),
                    path: file.file.path,
                    dirty: file.dirty,
                    externalChanged: file.externalChanged,
                  }))}
                revealRequest={fileRevealRequest && projectFileContextIds.has(fileRevealRequest.agentId) ? fileRevealRequest : undefined}
                focusSearchRequest={fileSearchFocusRequest && projectFileContextIds.has(fileSearchFocusRequest.agentId) ? fileSearchFocusRequest : undefined}
                onConsumeRevealRequest={onConsumeFileRevealRequest}
                onConsumeSearchFocusRequest={onConsumeFileSearchFocusRequest}
                editorDirtyFilePaths={projectEditorDirtyFilePaths}
                editorExternalChangedFilePaths={projectEditorExternalChangedFilePaths}
                onOpenFile={openProjectWorkspaceFile}
                onBeginOpenFileIntent={onBeginProjectFileOpenIntent}
                onResolveFile={onResolveProjectFile}
                onSelectOpenFile={selectOpenProjectWorkspaceFile}
                onCloseOpenFile={onCloseOpenWorkspaceFile}
                onNewAgent={onNewAgent}
                onStartAgent={onStartAgent}
                onMoveEntries={onMoveWorkspaceEntries}
                onDeleteEntries={onDeleteWorkspaceEntries}
                onRefreshOpenFiles={onRefreshProjectOpenFiles}
                refreshToken={branchSwitchRevision}
                readOnly={readOnly || globalRootProject}
                copy={copy}
              />
            </Suspense>
          )}
        </div>
      )}
    </>
  )
})

function ProjectNewAgentIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path fill="currentColor" d="M7.5 3C7.77614 3 8 3.22386 8 3.5V7H11.5C11.7761 7 12 7.22386 12 7.5C12 7.77614 11.7761 8 11.5 8H8V11.5C8 11.7761 7.77614 12 7.5 12C7.22386 12 7 11.7761 7 11.5V8H3.5C3.22386 8 3 7.77614 3 7.5C3 7.22386 3.22386 7 3.5 7H7V3.5C7 3.22386 7.22386 3 7.5 3Z" />
    </svg>
  )
}

function visibleAgentsWithForcedRows(
  agents: Agent[],
  limit: number,
  forcedIds: Array<string | null | undefined>,
  excludedIds: ReadonlySet<string>,
) {
  if (agents.length <= limit) return agents
  const visible = agents.slice(0, limit)
  const visibleIds = new Set(visible.map(agent => agent.id))
  const forced = new Set(forcedIds.filter((id): id is string => Boolean(id)))
  for (const agent of agents) {
    if (excludedIds.has(agent.id) || !forced.has(agent.id) || visibleIds.has(agent.id)) continue
    const removed = visible[visible.length - 1]!
    visibleIds.delete(removed.id)
    visible[visible.length - 1] = agent
    visibleIds.add(agent.id)
  }
  return visible
}

function ProjectActionsIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path fill="currentColor" d="M4 8C4 8.55228 3.55228 9 3 9C2.44772 9 2 8.55228 2 8C2 7.44772 2.44772 7 3 7C3.55228 7 4 7.44772 4 8ZM9 8C9 8.55228 8.55228 9 8 9C7.44772 9 7 8.55228 7 8C7 7.44772 7.44772 7 8 7C8.55228 7 9 7.44772 9 8ZM13 9C13.5523 9 14 8.55228 14 8C14 7.44772 13.5523 7 13 7C12.4477 7 12 7.44772 12 8C12 8.55228 12.4477 9 13 9Z" />
    </svg>
  )
}

function previewTargetForAgent(agent: Agent, rowState: ReturnType<typeof buildAgentRowDisplayState>, project?: string): AgentPreviewTarget {
  return {
    key: `agent:${agent.id}`,
    title: rowState.title,
    project: project || projectNameForWorkspace(agent.projectWorkspace || agent.cwd),
    lastActive: agent.lastActivity || agent.startedAt || 0,
    branch: currentWorktreeName(agentWorktreeList(agent.gitWorktree)),
    provider: previewAgentIconNameForAgent(agent),
    providerHomeId: nonDefaultAgentHomeId(agent.providerHomeId),
  }
}

function previewTargetForSession(session: AgentSessionHistoryItem, rowState: ReturnType<typeof buildAgentRowDisplayState>): AgentPreviewTarget {
  return {
    key: `session:${agentSessionId(session)}`,
    title: rowState.title,
    project: agentSessionProjectName(session),
    lastActive: agentSessionUpdatedAt(session),
    branch: '',
    provider: agentIconName(session.provider),
    providerHomeId: nonDefaultAgentHomeId(session.providerHomeId),
  }
}

function nonDefaultAgentHomeId(providerHomeId: string | undefined) {
  const normalized = providerHomeId?.trim() || ''
  return normalized && normalized.toLowerCase() !== 'default' ? normalized : undefined
}

function ProjectHoverPreview({
  preview,
  copy,
}: {
  preview: ProjectPreviewTarget & { x: number; y: number; width: number }
  copy: CodeCopy
}) {
  const worktreeLabel = preview.branch
    ? preview.worktreeCount > 1
      ? `${preview.branch} · ${preview.worktreeCount} ${copy.worktrees}`
      : preview.branch
    : ''
  return (
    <div
      className="code-project-hover-preview"
      data-testid="code-project-hover-preview"
      style={{ left: preview.x, top: preview.y, width: preview.width }}
      aria-hidden="true"
    >
      <div className="code-project-hover-preview-header">
        <span className="code-project-hover-preview-icon"><AgentPreviewFolderIcon /></span>
        <strong>{preview.name}</strong>
        {preview.pinned && <span className="code-project-hover-preview-pin"><AgentPinIcon /></span>}
      </div>
      <div className="code-project-hover-preview-line">
        <span className="code-project-hover-preview-icon"><ProjectPreviewAgentsIcon /></span>
        <span>{copy.projectAgentsSummary(preview.agentCount, preview.unreadCount, preview.runningCount)}</span>
      </div>
      <div className="code-project-hover-preview-line">
        <span className="code-project-hover-preview-icon"><AgentPreviewFolderIcon /></span>
        <span className="code-project-hover-preview-workspace">{formatWorkspaceForDisplay(preview.workspace)}</span>
      </div>
      {worktreeLabel && (
        <div className="code-project-hover-preview-line">
          <span className="code-project-hover-preview-icon"><AgentPreviewBranchIcon /></span>
          <span>{worktreeLabel}</span>
        </div>
      )}
    </div>
  )
}

function AgentHoverPreview({
  preview,
  now,
}: {
  preview: AgentPreviewTarget & { x: number; y: number; width: number; branch: string }
  now: number
}) {
  const titleRef = useRef<HTMLElement>(null)
  const previewRef = useRef<HTMLDivElement>(null)
  const [titleOverflow, setTitleOverflow] = useState(false)
  const [titleCardTop, setTitleCardTop] = useState(preview.y)
  const ageLabel = formatRelativeAge(preview.lastActive, now)
  useLayoutEffect(() => {
    const title = titleRef.current
    setTitleOverflow(Boolean(title && title.scrollWidth > title.clientWidth + 1))
    const previewElement = previewRef.current
    if (previewElement) setTitleCardTop(previewElement.getBoundingClientRect().bottom + 10)
  }, [ageLabel, preview.branch, preview.key, preview.providerHomeId, preview.title, preview.width, preview.x, preview.y])
  const titleCardLeft = preview.x
  const titleCardWidth = Math.min(360, window.innerWidth - titleCardLeft - 12)

  return (
    <>
      <div
        className="code-agent-hover-preview"
        data-testid="code-agent-hover-preview"
        ref={previewRef}
        style={{ left: preview.x, top: preview.y, width: preview.width }}
        aria-hidden="true"
      >
        <div className="code-agent-hover-preview-header">
          <strong ref={titleRef}>{preview.title}</strong>
          <span>{ageLabel}</span>
        </div>
        <div className="code-agent-hover-preview-line">
          <span className="code-agent-hover-preview-icon"><AgentPreviewFolderIcon /></span>
          <div className="code-agent-hover-preview-project">
            <span className="code-agent-hover-preview-project-name">{preview.project}</span>
            {preview.provider && <AgentLaunchIcon name={preview.provider} variant="color" className="code-agent-hover-preview-provider-icon" />}
          </div>
        </div>
        {preview.branch && (
          <div className="code-agent-hover-preview-line" data-testid="code-agent-hover-preview-branch">
            <span className="code-agent-hover-preview-icon"><AgentPreviewBranchIcon /></span>
            <span>{preview.branch}</span>
          </div>
        )}
        {preview.providerHomeId && (
          <div className="code-agent-hover-preview-line" data-testid="code-agent-hover-preview-home">
            <span className="code-agent-hover-preview-icon"><AgentPreviewHomeIcon /></span>
            <span>{preview.providerHomeId}</span>
          </div>
        )}
        {(Boolean(preview.browserCount) || Boolean(preview.desktopCount)) && (
          <div className="code-agent-hover-preview-resources" data-testid="code-agent-hover-preview-resources">
            {Boolean(preview.browserCount) && (
              <span className="code-agent-hover-preview-resource" data-testid="code-agent-hover-preview-browser-count">
                <BrowserGlyph />
                <span>{preview.browserCount}</span>
              </span>
            )}
            {Boolean(preview.desktopCount) && (
              <span className="code-agent-hover-preview-resource" data-testid="code-agent-hover-preview-desktop-count">
                <DesktopGlyph />
                <span>{preview.desktopCount}</span>
              </span>
            )}
          </div>
        )}
      </div>
      {titleOverflow && titleCardWidth >= 180 && (
        <div
          className="code-agent-hover-title-card"
          data-testid="code-agent-hover-title-card"
          style={{ left: titleCardLeft, top: titleCardTop, width: titleCardWidth }}
          aria-hidden="true"
        >
          {preview.title}
        </div>
      )}
    </>
  )
}

function AgentPreviewFolderIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path fill="currentColor" d="M1.5 3.75C1.5 2.784 2.284 2 3.25 2h3.104c.464 0 .91.184 1.237.513l.841.842c.14.14.33.22.528.22h3.79c.966 0 1.75.784 1.75 1.75v6.925c0 .966-.784 1.75-1.75 1.75H3.25a1.75 1.75 0 0 1-1.75-1.75V3.75Zm1.75-.75a.75.75 0 0 0-.75.75v8.5c0 .414.336.75.75.75h9.5a.75.75 0 0 0 .75-.75V5.325a.75.75 0 0 0-.75-.75H8.96a1.75 1.75 0 0 1-1.235-.512l-.841-.842A.75.75 0 0 0 6.354 3H3.25Z" />
    </svg>
  )
}

function AgentPreviewHomeIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path fill="currentColor" d="M7.66 1.63a.5.5 0 0 1 .68 0l5.5 5.08a.5.5 0 1 1-.68.74L13 7.3v5.45A1.25 1.25 0 0 1 11.75 14h-7.5A1.25 1.25 0 0 1 3 12.75V7.3l-.16.15a.5.5 0 1 1-.68-.74l5.5-5.08ZM4 6.38v6.37c0 .14.11.25.25.25H6.5V9.75c0-.69.56-1.25 1.25-1.25h.5c.69 0 1.25.56 1.25 1.25V13h2.25c.14 0 .25-.11.25-.25V6.38L8 2.69 4 6.38ZM8.25 9.5h-.5a.25.25 0 0 0-.25.25V13h1V9.75a.25.25 0 0 0-.25-.25Z" />
    </svg>
  )
}

function ProjectPreviewAgentsIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path fill="currentColor" d="M8 1.5C4.41 1.5 1.5 4.08 1.5 7.25c0 1.34.53 2.58 1.43 3.56l-.7 2.46a.75.75 0 0 0 .93.92l2.68-.8c.68.22 1.4.36 2.16.36 3.59 0 6.5-2.58 6.5-5.75S11.59 1.5 8 1.5Zm0 1c3.09 0 5.5 2.18 5.5 4.75S11.09 12 8 12c-.72 0-1.41-.13-2.04-.36a.5.5 0 0 0-.32-.01l-2.21.66.57-2a.5.5 0 0 0-.13-.5A4.5 4.5 0 0 1 2.5 7.25C2.5 4.68 4.91 2.5 8 2.5Z" />
    </svg>
  )
}

function AgentPreviewBranchIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">
      <path d="M21 8.25C21 6.1815 19.3185 4.5 17.25 4.5C15.1815 4.5 13.5 6.1815 13.5 8.25C13.5 10.023 14.739 11.5035 16.395 11.892C16.116 12.819 15.2655 13.5 14.25 13.5H9.75C8.9025 13.5 8.1285 13.7925 7.5 14.268V7.4235C9.21 7.0755 10.5 5.5605 10.5 3.75C10.5 1.6815 8.8185 0 6.75 0C4.6815 0 3 1.6815 3 3.75C3 5.562 4.29 7.0755 6 7.4235V16.575C4.29 16.923 3 18.438 3 20.2485C3 22.317 4.6815 23.9985 6.75 23.9985C8.8185 23.9985 10.5 22.317 10.5 20.2485C10.5 18.4755 9.261 16.995 7.605 16.6065C7.884 15.6795 8.7345 14.9985 9.75 14.9985H14.25C16.0845 14.9985 17.61 13.6725 17.931 11.9295C19.674 11.607 21 10.0845 21 8.25ZM4.5 3.75C4.5 2.5095 5.5095 1.5 6.75 1.5C7.9905 1.5 9 2.5095 9 3.75C9 4.9905 7.9905 6 6.75 6C5.5095 6 4.5 4.9905 4.5 3.75ZM9 20.25C9 21.4905 7.9905 22.5 6.75 22.5C5.5095 22.5 4.5 21.4905 4.5 20.25C4.5 19.0095 5.5095 18 6.75 18C7.9905 18 9 19.0095 9 20.25ZM17.25 10.5C16.0095 10.5 15 9.4905 15 8.25C15 7.0095 16.0095 6 17.25 6C18.4905 6 19.5 7.0095 19.5 8.25C19.5 9.4905 18.4905 10.5 17.25 10.5Z" />
    </svg>
  )
}

function AgentPinIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M10.0589 2.44511C9.34701 1.73063 8.14697 1.90829 7.67261 2.79839L5.6526 6.58878L2.8419 7.52568C2.6775 7.58048 2.5532 7.71649 2.51339 7.88514C2.47357 8.0538 2.52392 8.23104 2.64646 8.35357L4.79291 10.5L2.14645 13.1465L2 14L2.85356 13.8536L5.50002 11.2071L7.64646 13.3536C7.76899 13.4761 7.94623 13.5265 8.11489 13.4866C8.28354 13.4468 8.41955 13.3225 8.47435 13.1581L9.41143 10.3469L13.1897 8.32423C14.0759 7.84982 14.2538 6.6551 13.5443 5.94305L10.0589 2.44511ZM8.55511 3.2687C8.71323 2.972 9.11324 2.91278 9.35055 3.15094L12.836 6.64889C13.0725 6.88624 13.0131 7.28448 12.7178 7.44262L8.76403 9.55921C8.65137 9.61952 8.56608 9.72068 8.52567 9.84191L7.7815 12.0744L3.92562 8.21853L6.15812 7.47436C6.27966 7.43385 6.38101 7.34823 6.44126 7.23518L8.55511 3.2687Z"
      />
    </svg>
  )
}

function AgentUnpinIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor" aria-hidden="true" focusable="false">
      <path d="M9.56016 10.2673L14.1464 14.8536C14.3417 15.0488 14.6583 15.0488 14.8536 14.8536C15.0488 14.6583 15.0488 14.3417 14.8536 14.1464L1.85355 1.14645C1.65829 0.951184 1.34171 0.951184 1.14645 1.14645C0.951184 1.34171 0.951184 1.65829 1.14645 1.85355L5.73223 6.43934L5.6526 6.58876L2.8419 7.52566C2.6775 7.58046 2.5532 7.71648 2.51339 7.88513C2.47357 8.05378 2.52392 8.23102 2.64646 8.35356L4.79291 10.5L2.14645 13.1465L2 14L2.85356 13.8536L5.50002 11.2071L7.64646 13.3536C7.76899 13.4761 7.94623 13.5264 8.11489 13.4866C8.28354 13.4468 8.41955 13.3225 8.47435 13.1581L9.41143 10.3469L9.56016 10.2673ZM8.82138 9.52849L8.76403 9.5592C8.65137 9.61951 8.56608 9.72066 8.52567 9.84189L7.7815 12.0744L3.92562 8.21851L6.15812 7.47435C6.27966 7.43383 6.38101 7.34822 6.44126 7.23516L6.47143 7.17854L8.82138 9.52849ZM12.7178 7.4426L10.6636 8.54227L11.4024 9.28105L13.1897 8.32422C14.0759 7.84981 14.2538 6.65509 13.5443 5.94304L10.0589 2.44509C9.34701 1.73062 8.14697 1.90828 7.67261 2.79838L6.71556 4.59421L7.45476 5.33341L8.55511 3.26869C8.71323 2.97199 9.11324 2.91277 9.35055 3.15093L12.836 6.64888C13.0725 6.88623 13.0131 7.28446 12.7178 7.4426Z" />
    </svg>
  )
}

function AgentArchiveIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M6.5 8C6.22386 8 6 8.22386 6 8.5C6 8.77614 6.22386 9 6.5 9H9.5C9.77614 9 10 8.77614 10 8.5C10 8.22386 9.77614 8 9.5 8H6.5ZM1 3.5C1 2.67157 1.67157 2 2.5 2H13.5C14.3284 2 15 2.67157 15 3.5V4.5C15 5.15311 14.5826 5.70873 14 5.91465V11.5C14 12.8807 12.8807 14 11.5 14H4.5C3.11929 14 2 12.8807 2 11.5V5.91465C1.4174 5.70873 1 5.15311 1 4.5V3.5ZM2.5 3C2.22386 3 2 3.22386 2 3.5V4.5C2 4.77614 2.22386 5 2.5 5H13.5C13.7761 5 14 4.77614 14 4.5V3.5C14 3.22386 13.7761 3 13.5 3H2.5ZM3 6V11.5C3 12.3284 3.67157 13 4.5 13H11.5C12.3284 13 13 12.3284 13 11.5V6H3Z"
      />
    </svg>
  )
}

function AgentNewWorktreeForkIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M12.854 14.8542L14.854 12.8542C15.049 12.6592 15.049 12.3422 14.854 12.1472L12.854 10.1472C12.659 9.95223 12.342 9.95223 12.147 10.1472C11.952 10.3422 11.952 10.6592 12.147 10.8542L13.293 12.0002H8.5C8.225 12.0002 8 11.7752 8 11.5002V5.50023C8 5.22523 8.225 5.00023 8.5 5.00023H13.293L12.147 6.14623C12.049 6.24423 12.001 6.37223 12.001 6.50023C12.001 6.62823 12.05 6.75623 12.147 6.85423C12.342 7.04923 12.659 7.04923 12.854 6.85423L14.854 4.85423C15.049 4.65923 15.049 4.34223 14.854 4.14723L12.854 2.14723C12.659 1.95223 12.342 1.95223 12.147 2.14723C11.952 2.34223 11.952 2.65923 12.147 2.85423L13.293 4.00023H8.5C7.673 4.00023 7 4.67323 7 5.50023V8.00023H1.5C1.224 8.00023 1 8.22423 1 8.50023C1 8.77623 1.224 9.00023 1.5 9.00023H7V11.5002C7 12.3272 7.673 13.0002 8.5 13.0002H13.293L12.147 14.1462C12.049 14.2442 12.001 14.3722 12.001 14.5002C12.001 14.6282 12.05 14.7562 12.147 14.8542C12.342 15.0492 12.659 15.0492 12.854 14.8542Z"
      />
    </svg>
  )
}

function AgentRow({
  agent,
  session,
  shortcutHint,
  active = false,
  searchSelected,
  now,
  dynamicPinningEnabled = false,
  onOpenAgent,
  onUpdateAgentFlags,
  reorderable = false,
  dragging = false,
  dropPosition,
  onAgentDragStart,
  onAgentDragEnd,
  onAgentDragOver,
  onAgentDrop,
  onOpenAgentMenu,
  onResume,
  onOpenSessionMenu,
  onToggleSessionPinned,
  onArchiveSession,
  onShowPreview,
  onHidePreview,
  copy,
}: {
  agent?: Agent
  session?: AgentSessionHistoryItem
  shortcutHint?: string
  active?: boolean
  searchSelected: boolean
  now: number
  dynamicPinningEnabled?: boolean
  onOpenAgent?: (agentId: string) => void
  onUpdateAgentFlags?: (agent: Agent, flags: Partial<Pick<Agent, 'followUp' | 'pinned' | 'archived'>>) => void
  reorderable?: boolean
  dragging?: boolean
  dropPosition?: 'before' | 'after'
  onAgentDragStart?: (event: ReactDragEvent<HTMLElement>, agentId: string) => void
  onAgentDragEnd?: () => void
  onAgentDragOver?: (event: ReactDragEvent<HTMLElement>, agentId: string) => void
  onAgentDrop?: (event: ReactDragEvent<HTMLElement>, agentId: string) => void
  onOpenAgentMenu?: (event: ContextMenuTriggerEvent, agentId: string) => void
  onResume?: (provider: string, sessionId: string, providerHomeId?: string) => void
  onOpenSessionMenu?: (event: ContextMenuTriggerEvent, provider: string, sessionId: string) => void
  onToggleSessionPinned?: (session: AgentSessionHistoryItem) => void
  onArchiveSession?: (session: AgentSessionHistoryItem) => void
  onShowPreview?: (event: AgentPreviewAnchorEvent, target: AgentPreviewTarget, compact?: boolean) => void
  onHidePreview?: () => void
  copy: CodeCopy
}) {
  const draggedRef = useRef(false)
  const liveAgent = useAgentWithLiveState(agent)
  const backing = liveAgent
    ? { kind: 'agent' as const, agent: liveAgent }
    : session
      ? { kind: 'history' as const, session, fallbackTitle: copy.sessionFallbackTitle(session.providerName) }
      : null
  if (!backing) return null

  const rowState = buildAgentRowDisplayState(backing, now, {
    ageTimestamp: dynamicPinningEnabled && liveAgent
      ? dynamicPinActivityAt(liveAgent, now)
      : undefined,
    forceAgeVisible: dynamicPinningEnabled,
  })
  const requiresResume = rowState.requiresResume
  const liveAgentId = liveAgent?.id ?? ''
  const sessionProvider = session?.provider ?? ''
  const sessionId = session?.id ?? ''
  const rowTestId = requiresResume ? 'code-active-session-row' : 'code-agent-row'
  const providerIcon = liveAgent
    ? previewAgentIconNameForAgent(liveAgent)
    : agentIconName(session?.provider)
  const prepareLiveChat = () => {
    if (!liveAgent || !isAcpRuntime(liveAgent)) return
    void fetch(appPath(`/api/agents/${encodeURIComponent(liveAgent.id)}/acp-transcript/prepare`), {
      method: 'POST',
    }).catch(() => {})
  }
  const openRow = () => {
    if (requiresResume) {
      onHidePreview?.()
      if (sessionProvider && sessionId) onResume?.(sessionProvider, sessionId, session?.providerHomeId)
      return
    }
    if (liveAgentId) onOpenAgent?.(liveAgentId)
  }
  const togglePinned = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.preventDefault()
    event.stopPropagation()
    if (liveAgent) {
      onUpdateAgentFlags?.(liveAgent, { pinned: !rowState.pinned })
    } else if (session) {
      onToggleSessionPinned?.(session)
    }
  }
  const toggleFollowUp = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.preventDefault()
    event.stopPropagation()
    if (!liveAgent) return
    onUpdateAgentFlags?.(liveAgent, { followUp: liveAgent.followUp !== true })
  }
  const archiveAgent = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.preventDefault()
    event.stopPropagation()
    if (liveAgent) {
      onUpdateAgentFlags?.(liveAgent, { archived: true })
    } else if (session) {
      onArchiveSession?.(session)
    }
  }
  const openRowMenu = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.preventDefault()
    event.stopPropagation()
    if (requiresResume) {
      onHidePreview?.()
      if (sessionProvider && session) onOpenSessionMenu?.(event, sessionProvider, agentSessionId(session))
      return
    }
    if (liveAgentId) onOpenAgentMenu?.(event, liveAgentId)
  }
  return (
    <>
    <div
      tabIndex={0}
      className={`code-agent-row ${providerIcon ? 'has-provider' : ''} ${requiresResume ? 'requires-resume' : ''} ${active ? 'active' : ''} ${searchSelected ? 'search-selected' : ''} ${rowState.pinned ? 'pinned' : ''} ${liveAgent?.followUp === true ? 'follow-up' : ''} ${rowState.unread ? 'unread' : ''} ${dynamicPinningEnabled ? 'force-age' : ''} ${dragging ? 'dragging' : ''} ${dropPosition ? `drop-${dropPosition}` : ''}`}
      draggable={(reorderable && !isTouchInputViewport()) || undefined}
      data-testid={rowTestId}
      data-agent-id={liveAgent?.id}
      data-activity-level={liveAgent?.activityLevel}
      data-provider={session?.provider}
      data-session-id={session ? agentSessionId(session) : undefined}
      aria-label={rowState.rowTitle || rowState.title}
      onDragStart={event => {
        if (!liveAgentId || !reorderable) return
        draggedRef.current = true
        onAgentDragStart?.(event, liveAgentId)
      }}
      onDragEnd={() => {
        onAgentDragEnd?.()
        window.setTimeout(() => {
          draggedRef.current = false
        }, 0)
      }}
      onDragOver={event => liveAgentId && reorderable && onAgentDragOver?.(event, liveAgentId)}
      onDrop={event => liveAgentId && reorderable && onAgentDrop?.(event, liveAgentId)}
      onClick={event => {
        if (draggedRef.current) {
          event.preventDefault()
          event.stopPropagation()
          return
        }
        openRow()
      }}
      onPointerDown={event => {
        if (event.button === 0) prepareLiveChat()
      }}
      onFocus={event => {
        if (event.currentTarget.matches(':focus-visible')) prepareLiveChat()
      }}
      onMouseEnter={event => {
        if (liveAgent) {
          onShowPreview?.(event, previewTargetForAgent(liveAgent, rowState))
        } else if (session) {
          onShowPreview?.(event, previewTargetForSession(session, rowState))
        }
      }}
      onMouseLeave={onHidePreview}
      onContextMenu={event => {
        if (requiresResume) {
          onHidePreview?.()
          if (sessionProvider && session) onOpenSessionMenu?.(event, sessionProvider, agentSessionId(session))
          return
        }
        if (liveAgentId) onOpenAgentMenu?.(event, liveAgentId)
      }}
      onKeyDown={event => {
        if (requiresResume) {
          if (sessionProvider && session) onOpenSessionMenu?.(event, sessionProvider, agentSessionId(session))
        } else if (liveAgentId) {
          onOpenAgentMenu?.(event, liveAgentId)
        }
        if (event.defaultPrevented) return
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          openRow()
        }
      }}
    >
      {providerIcon && (
        <span className="code-agent-row-provider-icon" aria-hidden="true">
          <AgentLaunchIcon name={providerIcon} variant="color" />
        </span>
      )}
      <span className={`code-agent-row-copy ${rowState.detailLabel ? 'has-details' : ''}`}>
        <span className="code-agent-name">{rowState.title}</span>
        {rowState.detailLabel && (
          <span
            className="code-agent-meta"
            data-testid="code-agent-row-detail"
            title={rowState.detailLabel}
          >
            {rowState.detailLabel}
          </span>
        )}
      </span>
      <span className="code-agent-row-trailing">
        {rowState.statusIndicatorVisible && (
          <span
            className={`code-agent-dot ${rowState.lifecycleStatus} ${rowState.turnActive ? 'turn-active' : ''}`}
            title={rowState.commandTitle || rowState.lifecycleStatus}
          />
        )}
        {rowState.forkedToNewWorktree && (
          <span
            className="code-agent-fork-new-worktree"
            data-testid="code-agent-new-worktree-fork"
            title={copy.newWorktreeFork}
            aria-label={copy.newWorktreeFork}
            role="img"
          >
            <AgentNewWorktreeForkIcon />
          </span>
        )}
        {rowState.scheduled && (
          <span
            className="code-agent-schedule-clock"
            data-testid="code-agent-schedule-clock"
            title={rowState.scheduleTitle}
            aria-label={rowState.scheduleTitle || copy.scheduledTask}
          />
        )}
        {liveAgent?.followUp === true && (
          <span
            className="code-agent-follow-up"
            data-testid="code-agent-follow-up"
            title={copy.followUp}
            aria-label={copy.followUp}
            role="img"
          >
            <FieldFlagGlyph filled />
          </span>
        )}
        {rowState.unread && <span className="code-agent-unread" title={copy.unread} />}
        {rowState.ageVisible && (
          <span
            className="code-agent-age code-agent-relative-age"
            data-testid="code-agent-row-age"
            title={rowState.ageTitle}
          >
            {rowState.ageLabel}
          </span>
        )}
        {(agent || session) && (
          <span className={`code-agent-row-actions ${session ? 'session' : ''}`} aria-hidden={false}>
            {liveAgent && (
              <span
                className="code-agent-resource-action-slot"
                data-testid="code-agent-resource-action-slot"
                data-agent-id={liveAgent.id}
              />
            )}
            {agent && (
              <button
                type="button"
                className={`code-agent-row-action follow-up ${liveAgent?.followUp === true ? 'active' : ''}`}
                data-testid="code-agent-row-follow-up"
                aria-label={liveAgent?.followUp === true ? copy.unmarkFollowUp : copy.markFollowUp}
                aria-pressed={liveAgent?.followUp === true}
                title={liveAgent?.followUp === true ? copy.unmarkFollowUp : copy.markFollowUp}
                onClick={toggleFollowUp}
              >
                <FieldFlagGlyph filled={liveAgent?.followUp === true} />
              </button>
            )}
            <button
              type="button"
              className={`code-agent-row-action pin ${rowState.pinned ? 'active' : ''}`}
              data-testid="code-agent-row-pin"
              aria-label={rowState.pinned
                ? (session ? copy.unpinChat : copy.unpinAgent)
                : (session ? copy.pinChat : copy.pinAgent)}
              title={rowState.pinned
                ? (session ? copy.unpinChat : copy.unpinAgent)
                : (session ? copy.pinChat : copy.pinAgent)}
              onClick={togglePinned}
            >
              {rowState.pinned ? <AgentUnpinIcon /> : <AgentPinIcon />}
            </button>
            <button
              type="button"
              className="code-agent-row-action archive"
              data-testid="code-agent-row-archive"
              aria-label={session ? copy.archiveChat : copy.archiveAgent}
              title={session ? copy.archiveChat : copy.archiveAgent}
              onClick={archiveAgent}
            >
              <AgentArchiveIcon />
            </button>
          </span>
        )}
        {(agent || session) && (
          <button
            type="button"
            className="code-agent-row-more"
            data-testid="code-agent-row-more"
            aria-label={copy.openOptions}
            title={copy.openOptions}
            onClick={openRowMenu}
          >
            <ProjectActionsIcon />
          </button>
        )}
        {shortcutHint && <kbd>{shortcutHint}</kbd>}
      </span>
    </div>
    {liveAgent && (
      <div
        className="code-agent-resource-slot"
        data-testid="code-agent-resource-slot"
        data-agent-id={liveAgent.id}
      />
    )}
    </>
  )
}
