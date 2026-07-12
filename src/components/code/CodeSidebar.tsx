import type {
  DragEvent as ReactDragEvent,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  RefObject,
} from 'react'
import { createPortal } from 'react-dom'
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  ChevronDownGlyph,
  ChevronLeftGlyph,
  ChevronRightGlyph,
  SettingsGlyph,
  SearchGlyph,
} from '@/components/IconGlyphs'
import type { Agent, ProviderQuotaLimit, SystemStats, UsageProviderSummary, UsageSummary } from '@/types/agent'
import type { WorkspaceFileDeleteResult, WorkspaceFileMove } from '@/lib/workspace-files'
import { appPath } from '@/lib/base-path'
import { agentDisplayName, agentTitle, formatRelativeAge } from '@/lib/format'
import {
  GLOBAL_WORKSPACE_FILES_AGENT_ID,
  GLOBAL_WORKSPACE_FILES_PROJECT_ID,
  GLOBAL_WORKSPACE_FILES_ROOT,
  isGlobalWorkspaceFilesAgentId,
} from '@/lib/global-workspace-files'
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
import { BrandAboutDialog } from './BrandAboutDialog'
import { mobileActionMenuPoint, outwardContextMenuPoint } from './menu-position'
import { ShareQrButton } from './ShareQrButton'
import { isMobileTouchViewport } from '@/lib/responsive-mode'
import { stableProjectFileAgentId } from './workspace-derived'

declare const __FARMING_PACKAGE_VERSION__: string

const DEFAULT_PROJECT_SESSION_LIMIT = 5
const PROJECT_AGENT_VISIBLE_LIMIT = 5
const PROJECT_AGENT_DROP_END = '__project_agent_drop_end__'
type AgentPreviewAnchorEvent = { currentTarget: HTMLElement }

type AgentPreviewTarget = {
  key: string
  title: string
  project: string
  lastActive: number
  provider?: PreviewAgentIconName
  agentId?: string
}

type PreviewAgentIconName = 'codex' | 'claude' | 'opencode' | 'qoder' | 'bash' | 'zsh'

function previewAgentIconName(value?: string): PreviewAgentIconName | undefined {
  const normalized = value?.trim().toLowerCase() || ''
  if (normalized === 'claude-code') return 'claude'
  if (['codex', 'claude', 'opencode', 'qoder', 'bash', 'zsh'].includes(normalized)) {
    return normalized as PreviewAgentIconName
  }
  return undefined
}

function previewAgentIconNameForAgent(agent: Agent): PreviewAgentIconName | undefined {
  const provider = previewAgentIconName(agent.providerSessionProvider)
  if (provider) return provider
  const command = agent.command.trim().split(/\s+/).find(token => (
    token !== 'env' && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)
  ))
  return previewAgentIconName(command?.split('/').pop())
}

type PinnedSidebarItem =
  | { kind: 'agent'; agent: Agent }
  | { kind: 'agent-session'; session: AgentSessionHistoryItem }

type SidebarRailItem = { agent: Agent; projectName: string }

function FocusModeGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor" aria-hidden="true">
      <path d="M3.75 3C3.33579 3 3 3.33579 3 3.75V5.5C3 5.77614 2.77614 6 2.5 6C2.22386 6 2 5.77614 2 5.5V3.75C2 2.7835 2.7835 2 3.75 2H5.5C5.77614 2 6 2.22386 6 2.5C6 2.77614 5.77614 3 5.5 3H3.75ZM10 2.5C10 2.22386 10.2239 2 10.5 2H12.25C13.2165 2 14 2.7835 14 3.75V5.5C14 5.77614 13.7761 6 13.5 6C13.2239 6 13 5.77614 13 5.5V3.75C13 3.33579 12.6642 3 12.25 3H10.5C10.2239 3 10 2.77614 10 2.5ZM2.5 10C2.77614 10 3 10.2239 3 10.5V12.25C3 12.6642 3.33579 13 3.75 13H5.5C5.77614 13 6 13.2239 6 13.5C6 13.7761 5.77614 14 5.5 14H3.75C2.7835 14 2 13.2165 2 12.25V10.5C2 10.2239 2.22386 10 2.5 10ZM13.5 10C13.7761 10 14 10.2239 14 10.5V12.25C14 13.2165 13.2165 14 12.25 14H10.5C10.2239 14 10 13.7761 10 13.5C10 13.2239 10.2239 13 10.5 13H12.25C12.6642 13 13 12.6642 13 12.25V10.5C13 10.2239 13.2239 10 13.5 10Z" />
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
  sidebarCollapsed: boolean
  activeView: WorkspaceView
  searchOpen: boolean
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
  systemStats: SystemStats | null
  usageSummary: UsageSummary | null
  shareTarget: WorkspaceShareTarget | null
  agentLaunchOptions: AgentLaunchOption[]
  agentCreationWorkspace?: string
  openWorkspaceFile: OpenWorkspaceFile | null
  openWorkspaceFiles: OpenWorkspaceFile[]
  fileRevealRequest: { agentId: string; path: string; kind: 'directory' | 'file'; requestId: number } | null
  fileSearchFocusRequest: { agentId: string; requestId: number; query?: string } | null
  projectListRef: RefObject<HTMLDivElement | null>
  onNewAgent: (workspace?: string, command?: string, returnFocusTarget?: HTMLElement | null) => void
  onStartAgent: (command: string, workspace: string, options?: { projectWorkspace?: string }) => void
  onToggleSidebar: () => void
  onOpenSearch: () => void
  onOpenWorkspaceView: (view: WorkspaceView) => void
  onOpenMainAgent: () => void
  onRestartMainAgent: (command: 'codex' | 'claude' | 'opencode' | 'qoder' | 'bash' | 'zsh') => void
  onProjectListKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void
  onToggleProject: (projectId: string) => void
  onToggleProjectSessions: (projectId: string) => void
  onOpenProjectContextMenu: (event: ReactMouseEvent<HTMLElement>, projectId: string) => void
  onOpenProjectKeyboardMenu: (event: ReactKeyboardEvent<HTMLElement>, projectId: string) => void
  onOpenAgent: (agentId: string) => void
  onUpdateAgentFlags: (agent: Agent, flags: Partial<Pick<Agent, 'pinned' | 'archived'>>) => void
  onReorderAgent: (agentId: string, beforeAgentId: string, afterAgentId: string) => void
  onOpenAgentContextMenu: (event: ReactMouseEvent<HTMLElement>, agentId: string) => void
  onOpenAgentKeyboardMenu: (event: ReactKeyboardEvent<HTMLElement>, agentId: string) => void
  onResumeAgentSession: (provider: string, sessionId: string, providerHomeId?: string) => void
  onOpenAgentSessionContextMenu: (event: ReactMouseEvent<HTMLElement>, provider: string, sessionId: string) => void
  onOpenAgentSessionKeyboardMenu: (event: ReactKeyboardEvent<HTMLElement>, provider: string, sessionId: string) => void
  onOpenProjectFile: (agentId: string, file: OpenWorkspaceFile['file'], target?: WorkspaceFileOpenTarget) => void
  onSelectOpenWorkspaceFile: (agentId: string, filePath: string, target?: WorkspaceFileOpenTarget) => boolean
  onCloseOpenWorkspaceFile: (agentId: string, filePath: string, workspaceRoot?: string) => void
  onMoveWorkspaceEntries: (agentId: string, moves: WorkspaceFileMove[]) => void
  onDeleteWorkspaceEntries: (agentId: string, deletions: WorkspaceFileDeleteResult[]) => void
  onOpenOptionsMenu: (event: ReactMouseEvent<HTMLElement>) => void
  copy: CodeCopy
}

export function CodeSidebar({
  sidebarCollapsed,
  activeView,
  searchOpen,
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
  systemStats,
  usageSummary,
  shareTarget,
  agentLaunchOptions,
  agentCreationWorkspace,
  openWorkspaceFile,
  openWorkspaceFiles,
  fileRevealRequest,
  fileSearchFocusRequest,
  projectListRef,
  onNewAgent,
  onStartAgent,
  onToggleSidebar,
  onOpenSearch,
  onOpenWorkspaceView,
  onOpenMainAgent,
  onRestartMainAgent,
  onProjectListKeyDown,
  onToggleProject,
  onToggleProjectSessions,
  onOpenProjectContextMenu,
  onOpenProjectKeyboardMenu,
  onOpenAgent,
  onUpdateAgentFlags,
  onReorderAgent,
  onOpenAgentContextMenu,
  onOpenAgentKeyboardMenu,
  onResumeAgentSession,
  onOpenAgentSessionContextMenu,
  onOpenAgentSessionKeyboardMenu,
  onOpenProjectFile,
  onSelectOpenWorkspaceFile,
  onCloseOpenWorkspaceFile,
  onMoveWorkspaceEntries,
  onDeleteWorkspaceEntries,
  onOpenOptionsMenu,
  copy,
}: CodeSidebarProps) {
  const [agentPreview, setAgentPreview] = useState<(AgentPreviewTarget & {
    x: number
    y: number
    width: number
    branch: string
  }) | null>(null)
  const previewTimerRef = useRef<number | null>(null)
  const previewBrowsingRef = useRef(false)
  const branchCacheRef = useRef(new Map<string, { branch: string; expiresAt: number }>())
  const [usageCollapsed, setUsageCollapsed] = useState(true)
  const [pinnedCollapsed, setPinnedCollapsed] = useState(false)
  const [brandDialogOpen, setBrandDialogOpen] = useState(false)
  const closeBrandDialog = useCallback(() => setBrandDialogOpen(false), [])
  const [focusModeActive, setFocusModeActive] = useState(false)
  const [focusModeSupported, setFocusModeSupported] = useState(false)
  const [rootFilesCollapsed, setRootFilesCollapsed] = useState(false)
  const clearPreviewTimer = useCallback(() => {
    if (previewTimerRef.current === null) return
    window.clearTimeout(previewTimerRef.current)
    previewTimerRef.current = null
  }, [])
  const hideAgentPreview = useCallback(() => {
    clearPreviewTimer()
    setAgentPreview(null)
  }, [clearPreviewTimer])
  const resetAgentPreview = useCallback(() => {
    previewBrowsingRef.current = false
    hideAgentPreview()
  }, [hideAgentPreview])
  const showAgentPreview = useCallback((event: AgentPreviewAnchorEvent, target: AgentPreviewTarget, compact = false) => {
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
      const cachedBranch = target.agentId ? branchCacheRef.current.get(target.agentId) : undefined
      const branch = cachedBranch && cachedBranch.expiresAt > Date.now() ? cachedBranch.branch : ''
      previewBrowsingRef.current = true
      setAgentPreview({ ...target, x, y, width, branch })
      if (!target.agentId || branch) return
      fetch(appPath(`/api/files/branch?agentId=${encodeURIComponent(target.agentId)}`))
        .then(response => response.ok ? response.json() : null)
        .then((data: { branch?: string } | null) => {
          const resolvedBranch = typeof data?.branch === 'string' ? data.branch.trim() : ''
          branchCacheRef.current.set(target.agentId!, { branch: resolvedBranch, expiresAt: Date.now() + 30_000 })
          setAgentPreview(current => current?.key === target.key ? { ...current, branch: resolvedBranch } : current)
        })
        .catch(() => {
          branchCacheRef.current.set(target.agentId!, { branch: '', expiresAt: Date.now() + 30_000 })
        })
    }, delay)
  }, [clearPreviewTimer])

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

  const toggleFocusMode = useCallback(() => {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {})
      return
    }
    document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => {})
  }, [])
  const pinnedItems = displayedProjects
    .flatMap<PinnedSidebarItem>(project => [
      ...project.agents
        .filter(agent => agent.pinned)
        .map(agent => ({ kind: 'agent' as const, agent })),
      ...project.agentSessions
        .filter(session => session.pinned)
        .map(session => ({ kind: 'agent-session' as const, session })),
    ])
    .sort((a, b) => {
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
  const visibleProjectSections = displayedProjects.filter(project => (
    project.agents.some(agent => !agent.pinned || !agent.isMain)
    || project.agentSessions.some(session => !session.pinned)
    || (project.hiddenAgentSessionCount ?? 0) > 0
  ))
  const sidebarRailItems = displayedProjects.flatMap<SidebarRailItem>(project => [
    ...project.agents
      .filter(agent => !agent.isMain)
      .map(agent => ({ agent, projectName: project.name })),
  ])
  const globalWorkspaceOpenFiles = openWorkspaceFiles.filter(file => isGlobalWorkspaceFilesAgentId(file.agentId))
  const activeGlobalWorkspaceFile = openWorkspaceFile && isGlobalWorkspaceFilesAgentId(openWorkspaceFile.agentId)
    ? openWorkspaceFile
    : null
  const globalFilesRevealPending = fileRevealRequest?.agentId === GLOBAL_WORKSPACE_FILES_AGENT_ID
  const showGlobalFilesSection = globalWorkspaceOpenFiles.length > 0 || globalFilesRevealPending

  useEffect(() => {
    if (!showGlobalFilesSection) {
      setRootFilesCollapsed(false)
    }
  }, [showGlobalFilesSection])

  useEffect(() => {
    if (globalFilesRevealPending) setRootFilesCollapsed(false)
  }, [globalFilesRevealPending])
  const currentVersion = compactProductVersion(__FARMING_PACKAGE_VERSION__ || '')
  const currentVersionLabel = currentVersion ? `v${currentVersion}` : ''
  // Keep the numeric agent rail for the collapsed sidebar only in this release.
  // The FILES-pressure compression path made single-agent projects collapse to "1",
  // which saved no space and made the expanded sidebar harder to scan.
  const agentCompressionActive = sidebarCollapsed

  return (
    <aside
      className={`code-sidebar ${sidebarCollapsed ? 'collapsed' : ''}`}
      data-testid="code-sidebar"
      onMouseLeave={resetAgentPreview}
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
              <svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor" aria-hidden="true">
                <path d="M14.452 1.548C14.087 1.183 13.608 1 13.13 1C12.652 1 12.173 1.183 11.808 1.548L6.979 6.377C6.697 6.659 6.498 7.011 6.401 7.398L6.027 8.896C5.883 9.473 6.329 10.002 6.886 10.002C6.958 10.002 7.031 9.993 7.106 9.975L8.604 9.601C8.99 9.504 9.343 9.305 9.625 9.023L14.454 4.194C15.184 3.464 15.184 2.28 14.454 1.549L14.452 1.548ZM13.745 3.485L8.916 8.314C8.763 8.467 8.57 8.576 8.36 8.629L7.04 8.962L7.371 7.64C7.424 7.43 7.532 7.237 7.686 7.084L12.516 2.255C12.68 2.091 12.899 2 13.131 2C13.363 2 13.582 2.091 13.746 2.255C14.085 2.594 14.085 3.146 13.746 3.486L13.745 3.485ZM13 7.768L14 6.768V11.5C14 12.878 12.879 14 11.5 14H4.5C3.121 14 2 12.878 2 11.5V4.5C2 3.122 3.121 2 4.5 2H9.236L8.236 3H4.5C3.673 3 3 3.673 3 4.5V11.5C3 12.327 3.673 13 4.5 13H11.5C12.327 13 13 12.327 13 11.5V7.768Z" />
              </svg>
            </span>
            <span>{copy.newAgent}</span>
            {keyboardShortcutsEnabled && <kbd>N</kbd>}
          </button>
          <ShareQrButton copy={copy} sidebarCollapsed={sidebarCollapsed} shareTarget={shareTarget} />
          {focusModeSupported && !sidebarCollapsed && (
            <button
              type="button"
              className={`code-sidebar-focus-toggle ${focusModeActive ? 'active' : ''}`}
              data-testid="code-sidebar-focus-toggle"
              aria-label={focusModeActive ? copy.exitFocusMode : copy.enterFocusMode}
              title={focusModeActive ? copy.exitFocusMode : copy.enterFocusMode}
              aria-pressed={focusModeActive}
              onClick={toggleFocusMode}
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
                  <HistoryIcon />
                </span>
              </button>
            </>
          )}
          <button
            type="button"
            className="code-sidebar-toggle"
            data-testid="code-sidebar-toggle"
            aria-label={sidebarCollapsed ? copy.expandSidebar : copy.collapseSidebar}
            title={sidebarCollapsed ? copy.expandSidebar : copy.collapseSidebar}
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
        onKeyDown={onProjectListKeyDown}
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
            onOpenAgentContextMenu={onOpenAgentContextMenu}
            onOpenAgentKeyboardMenu={onOpenAgentKeyboardMenu}
            onResumeAgentSession={onResumeAgentSession}
            onOpenAgentSessionContextMenu={onOpenAgentSessionContextMenu}
            onOpenAgentSessionKeyboardMenu={onOpenAgentSessionKeyboardMenu}
            onShowAgentPreview={showAgentPreview}
            onHideAgentPreview={hideAgentPreview}
            onToggleCollapsed={() => setPinnedCollapsed(collapsed => !collapsed)}
            copy={copy}
          />
        )}
        {showGlobalFilesSection && (
          <section className="code-project-group code-root-files-group" data-testid="code-root-files-group">
            <div className="code-project-row code-root-files-row">
              <button
                type="button"
                className="code-project-title"
                data-testid="code-root-files-title"
                aria-expanded={!rootFilesCollapsed}
                onClick={() => setRootFilesCollapsed(collapsed => !collapsed)}
              >
                <span className={`code-folder-icon ${rootFilesCollapsed ? 'collapsed' : 'expanded'}`} aria-hidden="true">
                  {rootFilesCollapsed ? <ChevronRightGlyph /> : <ChevronDownGlyph />}
                </span>
                <span>/</span>
              </button>
            </div>
            {!rootFilesCollapsed && (
              <div className="code-project-expanded">
                <Suspense fallback={null}>
                  <ProjectFilesSection
                    projectId={GLOBAL_WORKSPACE_FILES_PROJECT_ID}
                    projectWorkspace={GLOBAL_WORKSPACE_FILES_ROOT}
                    agentId={GLOBAL_WORKSPACE_FILES_AGENT_ID}
                    agentLaunchOptions={[]}
                    activeFilePath={activeGlobalWorkspaceFile?.file.path}
                    openFiles={globalWorkspaceOpenFiles
                      .map(file => ({
                        agentId: file.agentId,
                        workspaceRoot: file.workspaceRoot,
                        key: workspaceOpenFileKey(file),
                        path: file.file.path,
                        dirty: file.dirty,
                        externalChanged: file.externalChanged,
                      }))}
                    revealRequest={fileRevealRequest?.agentId === GLOBAL_WORKSPACE_FILES_AGENT_ID ? fileRevealRequest : undefined}
                    focusSearchRequest={fileSearchFocusRequest?.agentId === GLOBAL_WORKSPACE_FILES_AGENT_ID ? fileSearchFocusRequest : undefined}
                    onOpenFile={onOpenProjectFile}
                    onSelectOpenFile={onSelectOpenWorkspaceFile}
                    onCloseOpenFile={onCloseOpenWorkspaceFile}
                    onMoveEntries={onMoveWorkspaceEntries}
                    onDeleteEntries={onDeleteWorkspaceEntries}
                    readOnly
                    copy={copy}
                  />
                </Suspense>
              </div>
            )}
          </section>
        )}
        {visibleProjectSections.map(project => (
          <ProjectSection
            key={project.id}
            project={project}
            collapsed={collapsedProjectIds.has(project.id) && !normalizedSearch}
            compactAgents={agentCompressionActive}
            activeTerminalId={activeTerminalId}
            selectedSearchAgentId={selectedSearchAgentId}
            selectedSearchSessionHandle={selectedSearchSessionHandle}
            claimedAgentSessionKeyByAgentId={claimedAgentSessionKeyByAgentId}
            agentShortcutKeys={agentShortcutKeys}
            keyboardShortcutsEnabled={keyboardShortcutsEnabled}
            now={now}
            openWorkspaceFile={openWorkspaceFile}
            openWorkspaceFiles={openWorkspaceFiles}
            agentLaunchOptions={agentLaunchOptions}
            fileRevealRequest={fileRevealRequest}
            fileSearchFocusRequest={fileSearchFocusRequest}
            onToggleProject={onToggleProject}
            onToggleProjectSessions={onToggleProjectSessions}
            onNewAgent={onNewAgent}
            onStartAgent={onStartAgent}
            onOpenProjectContextMenu={onOpenProjectContextMenu}
            onOpenProjectKeyboardMenu={onOpenProjectKeyboardMenu}
            onOpenAgent={onOpenAgent}
            onUpdateAgentFlags={onUpdateAgentFlags}
            onReorderAgent={onReorderAgent}
            onOpenAgentContextMenu={onOpenAgentContextMenu}
            onOpenAgentKeyboardMenu={onOpenAgentKeyboardMenu}
            onResumeAgentSession={onResumeAgentSession}
            onOpenAgentSessionContextMenu={onOpenAgentSessionContextMenu}
            onOpenAgentSessionKeyboardMenu={onOpenAgentSessionKeyboardMenu}
            onShowAgentPreview={showAgentPreview}
            onHideAgentPreview={hideAgentPreview}
            onOpenProjectFile={onOpenProjectFile}
            onSelectOpenWorkspaceFile={onSelectOpenWorkspaceFile}
            onCloseOpenWorkspaceFile={onCloseOpenWorkspaceFile}
            onMoveWorkspaceEntries={onMoveWorkspaceEntries}
            onDeleteWorkspaceEntries={onDeleteWorkspaceEntries}
            copy={copy}
          />
        ))}
      </div>

      <div className="code-sidebar-footer">
        <div className="code-product-row">
          <button
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
        {(usageSummary || systemStats || mainAgent) && (
          <>
            {!sidebarCollapsed && (usageSummary || systemStats || mainAgent) && (
              <UsagePanel
                collapsed={usageCollapsed}
                mainAgent={mainAgent}
                usageSummary={usageSummary}
                systemStats={systemStats}
                onToggleCollapsed={() => setUsageCollapsed(collapsed => !collapsed)}
                onOpenMainAgent={onOpenMainAgent}
                onRestartMainAgent={onRestartMainAgent}
              />
            )}
          </>
        )}
      </div>
      {agentPreview && (
        <AgentHoverPreview
          preview={agentPreview}
          now={now}
        />
      )}
      {brandDialogOpen && (
        <BrandAboutDialog copy={copy} version={currentVersionLabel} onClose={closeBrandDialog} />
      )}
    </aside>
  )
}

function formatUsageWindow(minutes: number | null | undefined) {
  const value = Number(minutes)
  if (!Number.isFinite(value) || value <= 0) return 'Window'
  if (value === 10080) return 'Weekly'
  if (value % 1440 === 0) return `${value / 1440}d`
  if (value % 60 === 0) return `${value / 60}h`
  return `${value}m`
}

function formatPercent(value: number | null | undefined) {
  const percent = Number(value)
  if (!Number.isFinite(percent)) return '--'
  return `${Math.round(percent)}%`
}

function formatRemainingPercent(value: number | null | undefined) {
  const usedPercent = Number(value)
  if (!Number.isFinite(usedPercent)) return '-- left'
  const remainingPercent = Math.max(0, Math.min(100, 100 - usedPercent))
  return `${Math.round(remainingPercent)}% left`
}

function formatQuotaRemaining(limit: ProviderQuotaLimit) {
  const remainingTokensRaw = limit.forecast?.remainingTokens
  const remainingTokens = remainingTokensRaw === null || remainingTokensRaw === undefined
    ? null
    : Number(remainingTokensRaw)
  if (typeof remainingTokens === 'number' && Number.isFinite(remainingTokens) && remainingTokens >= 0) {
    return `${formatCompactNumber(Math.round(remainingTokens))} tok left`
  }
  return formatRemainingPercent(limit.usedPercent)
}

function formatQuotaLimitValue(limit: ProviderQuotaLimit) {
  return formatQuotaRemaining(limit)
}

function formatQuotaLimitTitle(source: string, limit: ProviderQuotaLimit) {
  const parts = [source]
  const used = formatPercent(limit.usedPercent)
  const remaining = formatQuotaRemaining(limit)
  if (used !== '--') parts.push(`${used} used`)
  if (remaining !== '-- left') parts.push(remaining)
  return parts.filter(Boolean).join(' / ')
}

function formatCompactNumber(value: number) {
  if (value >= 1_000_000) {
    const compact = value / 1_000_000
    return `${compact >= 10 ? Math.round(compact) : Math.round(compact * 10) / 10}M`
  }
  if (value >= 1_000) {
    const compact = value / 1_000
    return `${compact >= 10 ? Math.round(compact) : Math.round(compact * 10) / 10}k`
  }
  return `${value}`
}

function formatTokenRate(value: number | null | undefined, approximate = false) {
  const rate = Number(value)
  if (!Number.isFinite(rate)) return '-- tok/min'
  const rounded = rate < 10 ? Math.round(rate * 10) / 10 : Math.round(rate)
  return `${approximate ? '~' : ''}${formatCompactNumber(rounded)} tok/min`
}

function formatAuthStatus(provider: UsageProviderSummary) {
  const status = provider.auth?.status || ''
  if (!provider.auth?.available) return 'offline'
  if (/logged in/i.test(status)) return 'logged in'
  return status || 'available'
}

function providerLocalTokenRate(usageSummary: UsageSummary | null) {
  if (!usageSummary?.providers.length) return null
  return usageSummary.providers.reduce((sum, provider) => {
    const rate = Number(provider.tokenUsage.tokensPerMinute)
    return sum + (Number.isFinite(rate) ? rate : 0)
  }, 0)
}

function quotaRemainingPercent(limit: ProviderQuotaLimit) {
  const forecastRemaining = limit.forecast?.remainingPercent
  if (typeof forecastRemaining === 'number' && Number.isFinite(forecastRemaining)) {
    return Math.max(0, Math.min(100, forecastRemaining))
  }
  const usedPercent = Number(limit.usedPercent)
  if (!Number.isFinite(usedPercent)) return null
  return Math.max(0, Math.min(100, 100 - usedPercent))
}

function quotaLimitSortWeight(limit: ProviderQuotaLimit) {
  const minutes = Number(limit.windowMinutes)
  if (Number.isFinite(minutes) && minutes >= 7 * 24 * 60 - 60) return 0
  if (Number.isFinite(minutes) && minutes >= 5 * 60 - 15 && minutes <= 5 * 60 + 15) return 1
  return 2
}

function providerQuotaLimits(provider: UsageProviderSummary) {
  return [provider.quota.primary, provider.quota.secondary]
    .filter((limit): limit is ProviderQuotaLimit => Boolean(limit))
    .map(limit => ({
      label: formatUsageWindow(limit.windowMinutes),
      limit,
      remaining: quotaRemainingPercent(limit),
      exhaustedAt: typeof limit.forecast?.projectedExhaustedAt === 'number' && Number.isFinite(limit.forecast.projectedExhaustedAt)
        ? limit.forecast.projectedExhaustedAt
        : null,
    }))
    .filter(item => item.remaining !== null)
    .sort((a, b) => quotaLimitSortWeight(a.limit) - quotaLimitSortWeight(b.limit))
}

function providerHasTokenBurn(provider: UsageProviderSummary) {
  const tokensPerMinute = Number(provider.tokenUsage.tokensPerMinute)
  return Number.isFinite(tokensPerMinute) && tokensPerMinute > 0
}

function dynamicQuotaProvider(usageSummary: UsageSummary | null) {
  if (!usageSummary?.providers.length) return null
  const candidates = usageSummary.providers
    .filter(provider => providerHasTokenBurn(provider) && provider.quota.available)
    .map(provider => {
      const limits = providerQuotaLimits(provider)
      const lowLimits = limits.filter(item => item.remaining !== null && item.remaining < 50)
      if (!lowLimits.length) return null
      const earliestExhaustedAt = lowLimits.reduce<number | null>((best, item) => {
        if (item.exhaustedAt === null) return best
        return best === null ? item.exhaustedAt : Math.min(best, item.exhaustedAt)
      }, null)
      const lowestRemaining = lowLimits.reduce((best, item) => Math.min(best, item.remaining ?? 100), 100)
      return {
        provider,
        limits,
        earliestExhaustedAt,
        lowestRemaining,
      }
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item))

  return candidates.sort((a, b) => {
    if (a.earliestExhaustedAt !== null && b.earliestExhaustedAt !== null) {
      return a.earliestExhaustedAt - b.earliestExhaustedAt
    }
    if (a.earliestExhaustedAt !== null) return -1
    if (b.earliestExhaustedAt !== null) return 1
    return a.lowestRemaining - b.lowestRemaining
  })[0] ?? null
}

function formatDynamicQuotaSummary(usageSummary: UsageSummary | null) {
  const candidate = dynamicQuotaProvider(usageSummary)
  if (!candidate) return null

  const parts = [
    candidate.provider.providerName,
    ...candidate.limits.map(item => `${item.label} ${Math.round(item.remaining ?? 0)}%`),
  ]
  return parts.join(' · ')
}

function formatDefaultCollapsedUsageSummary(usageSummary: UsageSummary | null, systemStats: SystemStats | null) {
  const parts: string[] = []
  const localTokenRate = providerLocalTokenRate(usageSummary)
  if (localTokenRate !== null) parts.push(formatTokenRate(localTokenRate))
  if (systemStats) parts.push(`CPU ${systemStats.cpu}% / MEM ${systemStats.memory.percentage}%`)
  return parts.join(' · ') || '5m'
}

function formatCollapsedUsageSummary(
  usageSummary: UsageSummary | null,
  systemStats: SystemStats | null,
) {
  const dynamicSummary = formatDynamicQuotaSummary(usageSummary)
  if (dynamicSummary) {
    return dynamicSummary
  }

  return formatDefaultCollapsedUsageSummary(usageSummary, systemStats)
}

function formatMainAgentStatus(agent: Agent) {
  if (agent.status === 'pending') return 'starting'
  if (agent.status === 'dead') return 'offline'
  return agent.status
}

function UsagePanel({
  collapsed,
  mainAgent,
  usageSummary,
  systemStats,
  onToggleCollapsed,
  onOpenMainAgent,
  onRestartMainAgent,
}: {
  collapsed: boolean
  mainAgent: Agent | null
  usageSummary: UsageSummary | null
  systemStats: SystemStats | null
  onToggleCollapsed: () => void
  onOpenMainAgent: () => void
  onRestartMainAgent: (command: 'codex' | 'claude' | 'opencode' | 'qoder' | 'bash' | 'zsh') => void
}) {
  const localTokenRate = providerLocalTokenRate(usageSummary)
  const collapsedSummary = formatCollapsedUsageSummary(usageSummary, systemStats)
  const [restartMenuOpen, setRestartMenuOpen] = useState(false)

  return (
    <div className={`code-usage-panel ${collapsed ? 'collapsed' : ''}`} data-testid="code-usage-panel">
      <button
        type="button"
        className="code-usage-header"
        data-testid="code-usage-toggle"
        aria-expanded={!collapsed}
        title="Provider local token usage refreshes periodically."
        onClick={onToggleCollapsed}
      >
        <span className="code-usage-title">
          <span className={`code-usage-chevron ${collapsed ? 'collapsed' : 'expanded'}`} aria-hidden="true">
            {collapsed ? <ChevronRightGlyph /> : <ChevronDownGlyph />}
          </span>
          <span>Usage</span>
        </span>
        <span className="code-usage-header-meta">
          <span className="code-usage-summary" data-testid="code-usage-summary">
            {collapsed ? collapsedSummary : '5m'}
          </span>
        </span>
      </button>
      {!collapsed && (
        <>
          {mainAgent && (
            <div className="code-usage-main-agent-block">
              <div
                className="code-usage-row code-usage-main-agent"
                title={`${agentTitle(mainAgent)} · ${mainAgent.command} · ${mainAgent.cwd}`}
                data-testid="code-main-agent-usage-row"
              >
                <button
                  type="button"
                  className="code-usage-main-agent-open"
                  data-testid="code-main-agent-open"
                  onClick={onOpenMainAgent}
                >
                  <span>Main Agent</span>
                  <strong>{formatMainAgentStatus(mainAgent)}</strong>
                </button>
                <button
                  type="button"
                  className="code-usage-main-agent-restart"
                  data-testid="code-main-agent-restart"
                  aria-expanded={restartMenuOpen}
                  onClick={() => setRestartMenuOpen(open => !open)}
                >
                  Restart
                </button>
              </div>
              {restartMenuOpen && (
                <div className="code-main-agent-restart-menu" data-testid="code-main-agent-restart-menu" role="menu">
                  {([
                    ['codex', 'Codex'],
                    ['claude', 'Claude Code'],
                    ['opencode', 'OpenCode'],
                    ['qoder', 'Qoder'],
                    ['bash', 'bash'],
                    ['zsh', 'zsh'],
                  ] as const).map(([command, label]) => (
                    <button
                      key={command}
                      type="button"
                      role="menuitem"
                      data-testid={`code-main-agent-restart-${command}`}
                      onClick={() => {
                        setRestartMenuOpen(false)
                        onRestartMainAgent(command)
                      }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {usageSummary?.providers.map(provider => (
            <ProviderUsage key={provider.provider} provider={provider} />
          ))}
          {localTokenRate !== null && (
            <div className="code-usage-row" title="Sum of local token usage reported by providers.">
              <span>Total local tokens</span>
              <strong>{formatTokenRate(localTokenRate)}</strong>
            </div>
          )}
          {systemStats && (
            <div className="code-usage-row">
              <span>System</span>
              <strong>CPU {systemStats.cpu}% / MEM {systemStats.memory.percentage}%</strong>
            </div>
          )}
        </>
      )}
    </div>
  )
}

function ProviderUsage({
  provider,
}: {
  provider: UsageProviderSummary
}) {
  const primary = provider.quota.primary ?? null
  const secondary = provider.quota.secondary ?? null
  const quotaTitle = provider.quota.available
    ? provider.quota.source
    : provider.quota.reason || provider.quota.source

  return (
    <div className="code-usage-provider">
      <div className="code-usage-row">
        <span>{provider.providerName}</span>
        <strong title={provider.auth?.status}>{formatAuthStatus(provider)}</strong>
      </div>
      {provider.quota.available ? (
        <>
          {primary && (
            <div className="code-usage-row code-usage-subrow" title={formatQuotaLimitTitle(quotaTitle, primary)}>
              <span>{formatUsageWindow(primary.windowMinutes)}</span>
              <strong>{formatQuotaLimitValue(primary)}</strong>
            </div>
          )}
          {secondary && (
            <div className="code-usage-row code-usage-subrow" title={formatQuotaLimitTitle(quotaTitle, secondary)}>
              <span>{formatUsageWindow(secondary.windowMinutes)}</span>
              <strong>{formatQuotaLimitValue(secondary)}</strong>
            </div>
          )}
        </>
      ) : (
        <div className="code-usage-row code-usage-subrow muted" title={quotaTitle}>
          <span>Quota</span>
          <strong>unavailable</strong>
        </div>
      )}
      <div className="code-usage-row code-usage-subrow" title={provider.tokenUsage.source}>
        <span>Local tokens</span>
        <strong>{formatTokenRate(provider.tokenUsage.tokensPerMinute)}</strong>
      </div>
    </div>
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
  onOpenAgentContextMenu,
  onOpenAgentKeyboardMenu,
  onShowPreview,
  onHidePreview,
}: {
  agents: Agent[]
  activeTerminalId: string | null
  selectedSearchAgentId: string | null
  claimedAgentSessionKeyByAgentId: ReadonlyMap<string, string>
  now: number
  onOpenAgent: (agentId: string) => void
  onOpenAgentContextMenu: (event: ReactMouseEvent<HTMLElement>, agentId: string) => void
  onOpenAgentKeyboardMenu: (event: ReactKeyboardEvent<HTMLElement>, agentId: string) => void
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
            onContextMenu={event => onOpenAgentContextMenu(event, agent.id)}
            onKeyDown={event => {
              onOpenAgentKeyboardMenu(event, agent.id)
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
  onOpenAgentContextMenu,
  onOpenAgentKeyboardMenu,
  onResumeAgentSession,
  onOpenAgentSessionContextMenu,
  onOpenAgentSessionKeyboardMenu,
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
  onOpenAgentContextMenu: (event: ReactMouseEvent<HTMLElement>, agentId: string) => void
  onOpenAgentKeyboardMenu: (event: ReactKeyboardEvent<HTMLElement>, agentId: string) => void
  onResumeAgentSession: (provider: string, sessionId: string, providerHomeId?: string) => void
  onOpenAgentSessionContextMenu: (event: ReactMouseEvent<HTMLElement>, provider: string, sessionId: string) => void
  onOpenAgentSessionKeyboardMenu: (event: ReactKeyboardEvent<HTMLElement>, provider: string, sessionId: string) => void
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
                onOpenAgentContextMenu(event, agent.id)
                return
              }
              if (session) onOpenAgentSessionContextMenu(event, session.provider, agentSessionId(session))
            }}
            onKeyDown={event => {
              if (agent) {
                onOpenAgentKeyboardMenu(event, agent.id)
              } else if (session) {
                onOpenAgentSessionKeyboardMenu(event, session.provider, agentSessionId(session))
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
  activeTerminalId: string | null
  selectedSearchAgentId: string | null
  selectedSearchSessionHandle: string | null
  claimedAgentSessionKeyByAgentId: ReadonlyMap<string, string>
  agentShortcutKeys: Map<string, string>
  keyboardShortcutsEnabled: boolean
  now: number
  onOpenAgent: (agentId: string) => void
  onUpdateAgentFlags: (agent: Agent, flags: Partial<Pick<Agent, 'pinned' | 'archived'>>) => void
  onReorderAgent: (agentId: string, beforeAgentId: string, afterAgentId: string) => void
  onOpenAgentContextMenu: (event: ReactMouseEvent<HTMLElement>, agentId: string) => void
  onOpenAgentKeyboardMenu: (event: ReactKeyboardEvent<HTMLElement>, agentId: string) => void
  onResumeAgentSession: (provider: string, sessionId: string, providerHomeId?: string) => void
  onOpenAgentSessionContextMenu: (event: ReactMouseEvent<HTMLElement>, provider: string, sessionId: string) => void
  onOpenAgentSessionKeyboardMenu: (event: ReactKeyboardEvent<HTMLElement>, provider: string, sessionId: string) => void
  onShowAgentPreview: (event: AgentPreviewAnchorEvent, target: AgentPreviewTarget, compact?: boolean) => void
  onHideAgentPreview: () => void
  onToggleCollapsed: () => void
  copy: CodeCopy
}

function PinnedSection({
  items,
  collapsed,
  compressed,
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
  onOpenAgentContextMenu,
  onOpenAgentKeyboardMenu,
  onResumeAgentSession,
  onOpenAgentSessionContextMenu,
  onOpenAgentSessionKeyboardMenu,
  onShowAgentPreview,
  onHideAgentPreview,
  onToggleCollapsed,
  copy,
}: PinnedSectionProps) {
  const pinnedAgents = items.flatMap(item => item.kind === 'agent' ? [item.agent] : [])
  const [agentDrag, setAgentDrag] = useState<{
    agentId: string
    targetAgentId: string
    position: 'before' | 'after'
  } | null>(null)
  const beginAgentDrag = (event: ReactDragEvent<HTMLElement>, agentId: string) => {
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', agentId)
    onHideAgentPreview()
    setAgentDrag({ agentId, targetAgentId: '', position: 'before' })
  }
  const updateAgentDropTarget = (event: ReactDragEvent<HTMLElement>, targetAgentId: string) => {
    if (!agentDrag || agentDrag.agentId === targetAgentId) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    const rect = event.currentTarget.getBoundingClientRect()
    const position = event.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
    if (agentDrag.targetAgentId === targetAgentId && agentDrag.position === position) return
    setAgentDrag(current => current ? { ...current, targetAgentId, position } : null)
  }
  const finishAgentDrag = () => setAgentDrag(null)
  const dropAgent = (event: ReactDragEvent<HTMLElement>, targetAgentId: string) => {
    event.preventDefault()
    if (!agentDrag || agentDrag.agentId === targetAgentId) {
      finishAgentDrag()
      return
    }
    const candidates = pinnedAgents.filter(agent => agent.id !== agentDrag.agentId)
    const targetIndex = candidates.findIndex(agent => agent.id === targetAgentId)
    if (targetIndex < 0) {
      finishAgentDrag()
      return
    }
    const insertIndex = agentDrag.position === 'before' ? targetIndex : targetIndex + 1
    onReorderAgent(
      agentDrag.agentId,
      insertIndex > 0 ? candidates[insertIndex - 1]?.id ?? '' : '',
      insertIndex < candidates.length ? candidates[insertIndex]?.id ?? '' : '',
    )
    finishAgentDrag()
  }
  return (
    <section className={`code-pinned-section ${collapsed ? 'collapsed' : ''}`} data-testid="code-pinned-section">
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
      {!collapsed && (
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
              onOpenAgentContextMenu={onOpenAgentContextMenu}
              onOpenAgentKeyboardMenu={onOpenAgentKeyboardMenu}
              onResumeAgentSession={onResumeAgentSession}
              onOpenAgentSessionContextMenu={onOpenAgentSessionContextMenu}
              onOpenAgentSessionKeyboardMenu={onOpenAgentSessionKeyboardMenu}
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
                    onOpenAgent={onOpenAgent}
                    onUpdateAgentFlags={onUpdateAgentFlags}
                    reorderable
                    dragging={agentDrag?.agentId === agent.id}
                    dropPosition={agentDrag?.targetAgentId === agent.id ? agentDrag.position : undefined}
                    onAgentDragStart={beginAgentDrag}
                    onAgentDragEnd={finishAgentDrag}
                    onAgentDragOver={updateAgentDropTarget}
                    onAgentDrop={dropAgent}
                    onOpenAgentContextMenu={onOpenAgentContextMenu}
                    onOpenAgentKeyboardMenu={onOpenAgentKeyboardMenu}
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
                  onResume={onResumeAgentSession}
                  onOpenSessionContextMenu={onOpenAgentSessionContextMenu}
                  onOpenSessionKeyboardMenu={onOpenAgentSessionKeyboardMenu}
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

interface ProjectSectionProps {
  project: ProjectGroup
  collapsed: boolean
  compactAgents: boolean
  activeTerminalId: string | null
  selectedSearchAgentId: string | null
  selectedSearchSessionHandle: string | null
  claimedAgentSessionKeyByAgentId: ReadonlyMap<string, string>
  agentShortcutKeys: Map<string, string>
  keyboardShortcutsEnabled: boolean
  now: number
  openWorkspaceFile: OpenWorkspaceFile | null
  openWorkspaceFiles: OpenWorkspaceFile[]
  agentLaunchOptions: AgentLaunchOption[]
  fileRevealRequest: { agentId: string; path: string; kind: 'directory' | 'file'; requestId: number } | null
  fileSearchFocusRequest: { agentId: string; requestId: number; query?: string } | null
  onToggleProject: (projectId: string) => void
  onToggleProjectSessions: (projectId: string) => void
  onNewAgent: (workspace?: string, command?: string, returnFocusTarget?: HTMLElement | null) => void
  onStartAgent: (command: string, workspace: string, options?: { projectWorkspace?: string }) => void
  onOpenProjectContextMenu: (event: ReactMouseEvent<HTMLElement>, projectId: string) => void
  onOpenProjectKeyboardMenu: (event: ReactKeyboardEvent<HTMLElement>, projectId: string) => void
  onOpenAgent: (agentId: string) => void
  onUpdateAgentFlags: (agent: Agent, flags: Partial<Pick<Agent, 'pinned' | 'archived'>>) => void
  onReorderAgent: (agentId: string, beforeAgentId: string, afterAgentId: string) => void
  onOpenAgentContextMenu: (event: ReactMouseEvent<HTMLElement>, agentId: string) => void
  onOpenAgentKeyboardMenu: (event: ReactKeyboardEvent<HTMLElement>, agentId: string) => void
  onResumeAgentSession: (provider: string, sessionId: string, providerHomeId?: string) => void
  onOpenAgentSessionContextMenu: (event: ReactMouseEvent<HTMLElement>, provider: string, sessionId: string) => void
  onOpenAgentSessionKeyboardMenu: (event: ReactKeyboardEvent<HTMLElement>, provider: string, sessionId: string) => void
  onShowAgentPreview: (event: AgentPreviewAnchorEvent, target: AgentPreviewTarget, compact?: boolean) => void
  onHideAgentPreview: () => void
  onOpenProjectFile: (agentId: string, file: OpenWorkspaceFile['file'], target?: WorkspaceFileOpenTarget) => void
  onSelectOpenWorkspaceFile: (agentId: string, filePath: string, target?: WorkspaceFileOpenTarget) => boolean
  onCloseOpenWorkspaceFile: (agentId: string, filePath: string, workspaceRoot?: string) => void
  onMoveWorkspaceEntries: (agentId: string, moves: WorkspaceFileMove[]) => void
  onDeleteWorkspaceEntries: (agentId: string, deletions: WorkspaceFileDeleteResult[]) => void
  copy: CodeCopy
}

function ProjectSection({
  project,
  collapsed,
  compactAgents,
  activeTerminalId,
  selectedSearchAgentId,
  selectedSearchSessionHandle,
  claimedAgentSessionKeyByAgentId,
  agentShortcutKeys,
  keyboardShortcutsEnabled,
  now,
  openWorkspaceFile,
  openWorkspaceFiles,
  agentLaunchOptions,
  fileRevealRequest,
  fileSearchFocusRequest,
  onToggleProject,
  onToggleProjectSessions,
  onNewAgent,
  onStartAgent,
  onOpenProjectContextMenu,
  onOpenProjectKeyboardMenu,
  onOpenAgent,
  onUpdateAgentFlags,
  onReorderAgent,
  onOpenAgentContextMenu,
  onOpenAgentKeyboardMenu,
  onResumeAgentSession,
  onOpenAgentSessionContextMenu,
  onOpenAgentSessionKeyboardMenu,
  onShowAgentPreview,
  onHideAgentPreview,
  onOpenProjectFile,
  onSelectOpenWorkspaceFile,
  onCloseOpenWorkspaceFile,
  onMoveWorkspaceEntries,
  onDeleteWorkspaceEntries,
  copy,
}: ProjectSectionProps) {
  const projectGroupRef = useRef<HTMLElement | null>(null)
  const projectRowRef = useRef<HTMLDivElement | null>(null)
  const agentsSectionRef = useRef<HTMLDivElement | null>(null)
  const launchButtonRef = useRef<HTMLButtonElement | null>(null)
  const launchMenuRef = useRef<HTMLDivElement | null>(null)
  const [launchMenu, setLaunchMenu] = useState<{ x: number; y: number } | null>(null)
  const [projectAgentsExpanded, setProjectAgentsExpanded] = useState(false)
  const [projectFilesExpanded, setProjectFilesExpanded] = useState(false)
  const [agentDrag, setAgentDrag] = useState<{
    agentId: string
    targetAgentId: string
    position: 'before' | 'after'
  } | null>(null)
  const [projectFileAgentId, setProjectFileAgentId] = useState<string | null>(() => (
    stableProjectFileAgentId(null, project.agents)
  ))
  const nextProjectFileAgentId = stableProjectFileAgentId(projectFileAgentId, project.agents)
  const projectFileAgent = project.agents.find(agent => (
    !agent.isMain && agent.id === nextProjectFileAgentId
  )) ?? null
  const showProjectFiles = project.id !== MAIN_AGENT_PROJECT_ID && projectFileAgent !== null
  const projectFileAgentIds = new Set(project.agents.filter(agent => !agent.isMain).map(agent => agent.id))
  const openFileBelongsToProject = useCallback((file: OpenWorkspaceFile) => (
    projectFileAgentIds.has(file.agentId) || file.workspaceRoot === project.id
  ), [project.id, projectFileAgentIds])
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
  const sortedAgents = project.agents.filter(agent => !agent.pinned)
  const visibleAgentSessions = project.agentSessions.filter(session => !session.pinned)
  const showAgentsSection = sortedAgents.length > 0 || visibleAgentSessions.length > 0 || (project.hiddenAgentSessionCount ?? 0) > 0
  const filesCompressAgents = projectFilesExpanded && isMobileTouchViewport() && sortedAgents.length > 1
  const compactProjectAgents = (compactAgents || filesCompressAgents) && sortedAgents.length > 0
  const visibleProjectAgents = compactProjectAgents || projectAgentsExpanded
    ? sortedAgents
    : visibleAgentsWithForcedRows(sortedAgents, PROJECT_AGENT_VISIBLE_LIMIT, [
      activeTerminalId,
      selectedSearchAgentId,
    ])
  const hiddenProjectAgentCount = Math.max(0, sortedAgents.length - visibleProjectAgents.length)

  useEffect(() => {
    if (projectFileAgentId !== nextProjectFileAgentId) {
      setProjectFileAgentId(nextProjectFileAgentId)
    }
  }, [nextProjectFileAgentId, projectFileAgentId])

  const handleFilesCollapsedChange = useCallback((filesCollapsed: boolean) => {
    setProjectFilesExpanded(!filesCollapsed)
  }, [])

  const beginAgentDrag = (event: ReactDragEvent<HTMLElement>, agentId: string) => {
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', agentId)
    onHideAgentPreview()
    setAgentDrag({ agentId, targetAgentId: '', position: 'before' })
  }
  const updateAgentDropTarget = (event: ReactDragEvent<HTMLElement>, targetAgentId: string) => {
    if (!agentDrag || agentDrag.agentId === targetAgentId) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    const rect = event.currentTarget.getBoundingClientRect()
    const position = event.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
    if (agentDrag.targetAgentId === targetAgentId && agentDrag.position === position) return
    setAgentDrag(current => current ? { ...current, targetAgentId, position } : null)
  }
  const finishAgentDrag = () => setAgentDrag(null)
  const dropAgent = (event: ReactDragEvent<HTMLElement>, targetAgentId: string) => {
    event.preventDefault()
    if (!agentDrag || agentDrag.agentId === targetAgentId) {
      finishAgentDrag()
      return
    }
    const candidates = sortedAgents.filter(agent => agent.id !== agentDrag.agentId)
    const targetIndex = candidates.findIndex(agent => agent.id === targetAgentId)
    if (targetIndex < 0) {
      finishAgentDrag()
      return
    }
    const insertIndex = agentDrag.position === 'before' ? targetIndex : targetIndex + 1
    onReorderAgent(
      agentDrag.agentId,
      insertIndex > 0 ? candidates[insertIndex - 1]?.id ?? '' : '',
      insertIndex < candidates.length ? candidates[insertIndex]?.id ?? '' : '',
    )
    finishAgentDrag()
  }
  const dropAgentAtProjectEnd = (event: ReactDragEvent<HTMLElement>) => {
    event.preventDefault()
    if (!agentDrag) return
    const candidates = sortedAgents.filter(agent => agent.id !== agentDrag.agentId)
    onReorderAgent(agentDrag.agentId, candidates[candidates.length - 1]?.id ?? '', '')
    finishAgentDrag()
  }
  const updateProjectEndDropTarget = (event: ReactDragEvent<HTMLElement>) => {
    if (!agentDrag) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    if (agentDrag.targetAgentId === PROJECT_AGENT_DROP_END) return
    setAgentDrag(current => current ? {
      ...current,
      targetAgentId: PROJECT_AGENT_DROP_END,
      position: 'after',
    } : null)
  }

  useEffect(() => {
    if (sortedAgents.length <= PROJECT_AGENT_VISIBLE_LIMIT && projectAgentsExpanded) {
      setProjectAgentsExpanded(false)
    }
  }, [projectAgentsExpanded, sortedAgents.length])

  useLayoutEffect(() => {
    const projectGroup = projectGroupRef.current
    if (!projectGroup) return

    const setStickyMetrics = () => {
      const projectRow = projectRowRef.current
      projectGroup.style.setProperty(
        '--code-project-sticky-height',
        projectRow ? `${Math.ceil(projectRow.getBoundingClientRect().height)}px` : '',
      )
      const agentsSection = agentsSectionRef.current
      projectGroup.style.setProperty(
        '--code-agents-sticky-height',
        agentsSection ? `${Math.ceil(agentsSection.getBoundingClientRect().height)}px` : '0px',
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
  }, [collapsed, project.id, showAgentsSection])

  useEffect(() => {
    if (!launchMenu) return

    const closeOnPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null
      if (target && (launchMenuRef.current?.contains(target) || launchButtonRef.current?.contains(target))) return
      setLaunchMenu(null)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setLaunchMenu(null)
      launchButtonRef.current?.focus()
    }

    window.addEventListener('pointerdown', closeOnPointerDown, true)
    window.addEventListener('keydown', closeOnEscape, true)
    return () => {
      window.removeEventListener('pointerdown', closeOnPointerDown, true)
      window.removeEventListener('keydown', closeOnEscape, true)
    }
  }, [launchMenu])

  const openProjectLaunchMenu = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.preventDefault()
    event.stopPropagation()
    if (agentLaunchOptions.length === 0) {
      onNewAgent(project.workspace, undefined, event.currentTarget)
      return
    }

    const rect = event.currentTarget.getBoundingClientRect()
    const menuWidth = 160
    const menuHeight = Math.min(260, agentLaunchOptions.length * 34 + 12)
    const point = isMobileTouchViewport()
      ? mobileActionMenuPoint(rect, menuHeight, undefined, menuWidth)
      : outwardContextMenuPoint(rect, menuHeight, undefined, menuWidth)
    setLaunchMenu(point)
  }

  const startProjectAgent = (command: string) => {
    setLaunchMenu(null)
    onStartAgent(command, project.workspace)
  }

  return (
    <section ref={projectGroupRef} className="code-project-group" data-testid="code-project-group">
      <div ref={projectRowRef} className="code-project-row">
        <button
          type="button"
          className="code-project-title"
          data-testid="code-project-title"
          data-project-id={project.id}
          aria-expanded={!collapsed}
          onClick={() => onToggleProject(project.id)}
          onContextMenu={event => onOpenProjectContextMenu(event, project.id)}
          onKeyDown={event => onOpenProjectKeyboardMenu(event, project.id)}
        >
          <span className={`code-folder-icon ${collapsed ? 'collapsed' : 'expanded'}`} aria-hidden="true">
            {collapsed ? <ChevronRightGlyph /> : <ChevronDownGlyph />}
          </span>
          <span>{project.name}</span>
        </button>
        <span className="code-project-title-actions" aria-hidden={false}>
          <button
            type="button"
            className="code-project-title-action"
            data-testid="code-project-actions"
            aria-label={copy.openOptions}
            title={copy.openOptions}
            onClick={event => onOpenProjectContextMenu(event, project.id)}
          >
            <ProjectActionsIcon />
          </button>
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
        </span>
        {launchMenu && typeof document !== 'undefined' && createPortal(
          <div
            ref={launchMenuRef}
            className="code-context-menu code-project-launch-menu"
            data-testid="code-project-new-agent-menu"
            role="menu"
            style={{ left: launchMenu.x, top: launchMenu.y }}
          >
            {agentLaunchOptions.map(option => (
              <button
                key={option.name}
                type="button"
                role="menuitem"
                data-testid={`code-project-agent-launch-${option.name}`}
                onClick={() => startProjectAgent(option.command || option.name)}
              >
                <AgentLaunchIcon name={option.name} />
                <span>{agentDisplayName(option.name)}</span>
              </button>
            ))}
          </div>,
          document.body
        )}
      </div>
      {!collapsed && (
        <div className="code-project-expanded">
          {showAgentsSection && (
            <div ref={agentsSectionRef} className="code-agents-section" data-testid="code-agents-section" data-project-id={project.id}>
              <div className="code-agent-list">
                {compactProjectAgents ? (
                  <ProjectAgentCompactStrip
                    agents={sortedAgents}
                    activeTerminalId={activeTerminalId}
                    selectedSearchAgentId={selectedSearchAgentId}
                    claimedAgentSessionKeyByAgentId={claimedAgentSessionKeyByAgentId}
                    now={now}
                    onOpenAgent={onOpenAgent}
                    onOpenAgentContextMenu={onOpenAgentContextMenu}
                    onOpenAgentKeyboardMenu={onOpenAgentKeyboardMenu}
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
                        onOpenAgentContextMenu={onOpenAgentContextMenu}
                        onOpenAgentKeyboardMenu={onOpenAgentKeyboardMenu}
                        onShowPreview={onShowAgentPreview}
                        onHidePreview={onHideAgentPreview}
                        copy={copy}
                      />
                    )
                  })
                )}
                {!compactProjectAgents && hiddenProjectAgentCount > 0 && (
                  <button
                    type="button"
                    className={`code-agent-row code-session-show-more ${agentDrag?.targetAgentId === PROJECT_AGENT_DROP_END ? 'drop-after' : ''}`}
                    data-testid="code-agent-show-more"
                    onClick={() => setProjectAgentsExpanded(true)}
                    onDragOver={updateProjectEndDropTarget}
                    onDrop={dropAgentAtProjectEnd}
                  >
                    <span className="code-agent-row-copy">
                      <span className="code-agent-name">{copy.showMore}</span>
                    </span>
                    <span className="code-agent-row-trailing">
                      <span className="code-agent-age">{hiddenProjectAgentCount}</span>
                    </span>
                  </button>
                )}
                {!compactProjectAgents && projectAgentsExpanded && sortedAgents.length > PROJECT_AGENT_VISIBLE_LIMIT && (
                  <button
                    type="button"
                    className="code-agent-row code-session-show-more"
                    data-testid="code-agent-show-less"
                    onClick={() => setProjectAgentsExpanded(false)}
                  >
                    <span className="code-agent-row-copy">
                      <span className="code-agent-name">{copy.showLess}</span>
                    </span>
                  </button>
                )}
                {visibleAgentSessions.map(session => (
                  <AgentRow
                    key={agentRowKey({ kind: 'history', session })}
                    session={session}
                    searchSelected={agentSessionId(session) === selectedSearchSessionHandle}
                    now={now}
                    onResume={onResumeAgentSession}
                    onOpenSessionContextMenu={onOpenAgentSessionContextMenu}
                    onOpenSessionKeyboardMenu={onOpenAgentSessionKeyboardMenu}
                    onShowPreview={onShowAgentPreview}
                    onHidePreview={onHideAgentPreview}
                    copy={copy}
                  />
                ))}
                {(project.hiddenAgentSessionCount ?? 0) > 0 && (
                  <button
                    type="button"
                    className="code-agent-row code-session-show-more"
                    data-testid="code-session-show-more"
                    onClick={() => onToggleProjectSessions(project.id)}
                  >
                    <span className="code-agent-row-copy">
                      <span className="code-agent-name">{copy.showMore}</span>
                    </span>
                    <span className="code-agent-row-trailing">
                      <span className="code-agent-age">{project.hiddenAgentSessionCount}</span>
                    </span>
                  </button>
                )}
                {project.agentSessionsExpanded && project.agentSessions.length > DEFAULT_PROJECT_SESSION_LIMIT && (
                  <button
                    type="button"
                    className="code-agent-row code-session-show-more"
                    data-testid="code-session-show-less"
                    onClick={() => onToggleProjectSessions(project.id)}
                  >
                    <span className="code-agent-row-copy">
                      <span className="code-agent-name">{copy.showLess}</span>
                    </span>
                  </button>
                )}
              </div>
            </div>
          )}
          {showProjectFiles && projectFileAgent && (
            <Suspense fallback={null}>
              <ProjectFilesSection
                projectId={project.id}
                projectWorkspace={project.workspace}
                agentId={projectFileAgent.id}
                agentLaunchOptions={agentLaunchOptions}
                activeFilePath={activeProjectFile?.file.path}
                openFiles={projectOpenWorkspaceFiles
                  .map(file => ({
                    agentId: file.agentId,
                    workspaceRoot: file.workspaceRoot,
                    key: workspaceOpenFileKey(file),
                    path: file.file.path,
                    dirty: file.dirty,
                    externalChanged: file.externalChanged,
                  }))}
                revealRequest={fileRevealRequest && projectFileAgentIds.has(fileRevealRequest.agentId) ? fileRevealRequest : undefined}
                focusSearchRequest={fileSearchFocusRequest && projectFileAgentIds.has(fileSearchFocusRequest.agentId) ? fileSearchFocusRequest : undefined}
                editorDirtyFilePaths={projectEditorDirtyFilePaths}
                editorExternalChangedFilePaths={projectEditorExternalChangedFilePaths}
                onOpenFile={onOpenProjectFile}
                onSelectOpenFile={onSelectOpenWorkspaceFile}
                onCloseOpenFile={onCloseOpenWorkspaceFile}
                onNewAgent={onNewAgent}
                onStartAgent={onStartAgent}
                onMoveEntries={onMoveWorkspaceEntries}
                onDeleteEntries={onDeleteWorkspaceEntries}
                onFilesCollapsedChange={handleFilesCollapsedChange}
                copy={copy}
              />
            </Suspense>
          )}
        </div>
      )}
    </section>
  )
}

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
) {
  if (agents.length <= limit) return agents
  const visible = agents.slice(0, limit)
  const visibleIds = new Set(visible.map(agent => agent.id))
  const forced = new Set(forcedIds.filter((id): id is string => Boolean(id)))
  for (const agent of agents) {
    if (!forced.has(agent.id) || visibleIds.has(agent.id)) continue
    if (visible.length >= limit && visible.length > 0) {
      const removed = visible[visible.length - 1]!
      visibleIds.delete(removed.id)
      visible[visible.length - 1] = agent
    } else {
      visible.push(agent)
    }
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
    provider: previewAgentIconNameForAgent(agent),
    agentId: agent.id,
  }
}

function previewTargetForSession(session: AgentSessionHistoryItem, rowState: ReturnType<typeof buildAgentRowDisplayState>): AgentPreviewTarget {
  return {
    key: `session:${agentSessionId(session)}`,
    title: rowState.title,
    project: agentSessionProjectName(session),
    lastActive: agentSessionUpdatedAt(session),
    provider: previewAgentIconName(session.provider),
  }
}

function AgentHoverPreview({
  preview,
  now,
}: {
  preview: AgentPreviewTarget & { x: number; y: number; width: number; branch: string }
  now: number
}) {
  return (
    <div
      className="code-agent-hover-preview"
      data-testid="code-agent-hover-preview"
      style={{ left: preview.x, top: preview.y, width: preview.width }}
      aria-hidden="true"
    >
      <div className="code-agent-hover-preview-header">
        <strong>{preview.title}</strong>
        <span>{formatRelativeAge(preview.lastActive, now)}</span>
      </div>
      <div className="code-agent-hover-preview-line">
        <span className="code-agent-hover-preview-icon"><AgentPreviewFolderIcon /></span>
        <div className="code-agent-hover-preview-project">
          <span className="code-agent-hover-preview-project-name">{preview.project}</span>
          {preview.provider && <AgentLaunchIcon name={preview.provider} variant="color" className="code-agent-hover-preview-provider-icon" />}
        </div>
      </div>
      <div className="code-agent-hover-preview-line">
        <span className="code-agent-hover-preview-icon"><AgentPreviewBranchIcon /></span>
        <span>{preview.branch || '—'}</span>
      </div>
    </div>
  )
}

function AgentPreviewFolderIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path fill="currentColor" d="M1.5 3.75C1.5 2.784 2.284 2 3.25 2h3.104c.464 0 .91.184 1.237.513l.841.842c.14.14.33.22.528.22h3.79c.966 0 1.75.784 1.75 1.75v6.925c0 .966-.784 1.75-1.75 1.75H3.25a1.75 1.75 0 0 1-1.75-1.75V3.75Zm1.75-.75a.75.75 0 0 0-.75.75v8.5c0 .414.336.75.75.75h9.5a.75.75 0 0 0 .75-.75V5.325a.75.75 0 0 0-.75-.75H8.96a1.75 1.75 0 0 1-1.235-.512l-.841-.842A.75.75 0 0 0 6.354 3H3.25Z" />
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

function HistoryIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M7.99909 3C10.7605 3 12.9991 5.23858 12.9991 8C12.9991 10.7614 10.7605 13 7.99909 13C5.39117 13 3.2491 11.003 3.0195 8.45512C2.99471 8.1801 2.75167 7.97723 2.47664 8.00202C2.20161 8.0268 1.99875 8.26985 2.02353 8.54488C2.29916 11.6035 4.86898 14 7.99909 14C11.3128 14 13.9991 11.3137 13.9991 8C13.9991 4.68629 11.3128 2 7.99909 2C6.20656 2 4.59815 2.78613 3.49909 4.03138V2.5C3.49909 2.22386 3.27524 2 2.99909 2C2.72295 2 2.49909 2.22386 2.49909 2.5V5.5C2.49909 5.77614 2.72295 6 2.99909 6H3.08812C3.09498 6.00014 3.10184 6.00014 3.10868 6H5.99909C6.27524 6 6.49909 5.77614 6.49909 5.5C6.49909 5.22386 6.27524 5 5.99909 5H3.99863C4.91128 3.78495 6.36382 3 7.99909 3ZM7.99909 5.5C7.99909 5.22386 7.77524 5 7.49909 5C7.22295 5 6.99909 5.22386 6.99909 5.5V8.5C6.99909 8.77614 7.22295 9 7.49909 9H9.49909C9.77524 9 9.99909 8.77614 9.99909 8.5C9.99909 8.22386 9.77524 8 9.49909 8H7.99909V5.5Z"
      />
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
  onOpenAgent,
  onUpdateAgentFlags,
  reorderable = false,
  dragging = false,
  dropPosition,
  onAgentDragStart,
  onAgentDragEnd,
  onAgentDragOver,
  onAgentDrop,
  onOpenAgentContextMenu,
  onOpenAgentKeyboardMenu,
  onResume,
  onOpenSessionContextMenu,
  onOpenSessionKeyboardMenu,
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
  onOpenAgent?: (agentId: string) => void
  onUpdateAgentFlags?: (agent: Agent, flags: Partial<Pick<Agent, 'pinned' | 'archived'>>) => void
  reorderable?: boolean
  dragging?: boolean
  dropPosition?: 'before' | 'after'
  onAgentDragStart?: (event: ReactDragEvent<HTMLElement>, agentId: string) => void
  onAgentDragEnd?: () => void
  onAgentDragOver?: (event: ReactDragEvent<HTMLElement>, agentId: string) => void
  onAgentDrop?: (event: ReactDragEvent<HTMLElement>, agentId: string) => void
  onOpenAgentContextMenu?: (event: ReactMouseEvent<HTMLElement>, agentId: string) => void
  onOpenAgentKeyboardMenu?: (event: ReactKeyboardEvent<HTMLElement>, agentId: string) => void
  onResume?: (provider: string, sessionId: string, providerHomeId?: string) => void
  onOpenSessionContextMenu?: (event: ReactMouseEvent<HTMLElement>, provider: string, sessionId: string) => void
  onOpenSessionKeyboardMenu?: (event: ReactKeyboardEvent<HTMLElement>, provider: string, sessionId: string) => void
  onShowPreview?: (event: AgentPreviewAnchorEvent, target: AgentPreviewTarget, compact?: boolean) => void
  onHidePreview?: () => void
  copy: CodeCopy
}) {
  const draggedRef = useRef(false)
  const backing = agent
    ? { kind: 'agent' as const, agent }
    : session
      ? { kind: 'history' as const, session, fallbackTitle: copy.sessionFallbackTitle(session.providerName) }
      : null
  if (!backing) return null

  const rowState = buildAgentRowDisplayState(backing, now)
  const requiresResume = rowState.requiresResume
  const liveAgentId = agent?.id ?? ''
  const sessionProvider = session?.provider ?? ''
  const sessionId = session?.id ?? ''
  const rowTestId = requiresResume ? 'code-active-session-row' : 'code-agent-row'
  const providerIcon = agent
    ? previewAgentIconNameForAgent(agent)
    : previewAgentIconName(session?.provider)
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
    if (!agent) return
    onUpdateAgentFlags?.(agent, { pinned: !rowState.pinned })
  }
  const archiveAgent = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.preventDefault()
    event.stopPropagation()
    if (!agent) return
    onUpdateAgentFlags?.(agent, { archived: true })
  }
  const openRowMenu = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.preventDefault()
    event.stopPropagation()
    if (requiresResume) {
      onHidePreview?.()
      if (sessionProvider && session) onOpenSessionContextMenu?.(event, sessionProvider, agentSessionId(session))
      return
    }
    if (liveAgentId) onOpenAgentContextMenu?.(event, liveAgentId)
  }

  return (
    <div
      tabIndex={0}
      className={`code-agent-row ${requiresResume ? 'requires-resume' : ''} ${active ? 'active' : ''} ${searchSelected ? 'search-selected' : ''} ${rowState.pinned ? 'pinned' : ''} ${rowState.unread ? 'unread' : ''} ${dragging ? 'dragging' : ''} ${dropPosition ? `drop-${dropPosition}` : ''}`}
      draggable={reorderable || undefined}
      data-testid={rowTestId}
      data-agent-id={agent?.id}
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
      onDragOver={event => liveAgentId && onAgentDragOver?.(event, liveAgentId)}
      onDrop={event => liveAgentId && onAgentDrop?.(event, liveAgentId)}
      onClick={event => {
        if (draggedRef.current) {
          event.preventDefault()
          event.stopPropagation()
          return
        }
        openRow()
      }}
      onMouseEnter={event => {
        if (agent) {
          onShowPreview?.(event, previewTargetForAgent(agent, rowState))
        } else if (session) {
          onShowPreview?.(event, previewTargetForSession(session, rowState))
        }
      }}
      onMouseLeave={onHidePreview}
      onContextMenu={event => {
        if (requiresResume) {
          onHidePreview?.()
          if (sessionProvider && session) onOpenSessionContextMenu?.(event, sessionProvider, agentSessionId(session))
          return
        }
        if (liveAgentId) onOpenAgentContextMenu?.(event, liveAgentId)
      }}
      onKeyDown={event => {
        if (requiresResume) {
          if (sessionProvider && session) onOpenSessionKeyboardMenu?.(event, sessionProvider, agentSessionId(session))
        } else if (liveAgentId) {
          onOpenAgentKeyboardMenu?.(event, liveAgentId)
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
      <span className="code-agent-row-copy">
        <span className="code-agent-name">{rowState.title}</span>
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
        {rowState.unread && <span className="code-agent-unread" title={copy.unread} />}
        {agent && (
          <span className="code-agent-row-actions" aria-hidden={false}>
            <button
              type="button"
              className={`code-agent-row-action pin ${rowState.pinned ? 'active' : ''}`}
              data-testid="code-agent-row-pin"
              aria-label={rowState.pinned ? copy.unpinAgent : copy.pinAgent}
              title={rowState.pinned ? copy.unpinAgent : copy.pinAgent}
              onClick={togglePinned}
            >
              {rowState.pinned ? <AgentUnpinIcon /> : <AgentPinIcon />}
            </button>
            <button
              type="button"
              className="code-agent-row-action archive"
              data-testid="code-agent-row-archive"
              aria-label={copy.archiveAgent}
              title={copy.archiveAgent}
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
  )
}
