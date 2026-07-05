import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  RefObject,
} from 'react'
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Agent, SystemStats, UsageProviderSummary, UsageSummary } from '@/types/agent'
import type { WorkspaceFileDeleteResult, WorkspaceFileMove } from '@/lib/workspace-files'
import { appPath } from '@/lib/base-path'
import { agentTitle, formatRelativeAge } from '@/lib/format'
import { workspaceOpenFileKey } from '@/lib/workspace-open-files'
import type { OpenWorkspaceFile } from '@/lib/workspace-open-files'
import {
  agentRowKey,
  buildAgentRowDisplayState,
} from './agent-row-state'
import type { CodeCopy } from './copy'
import {
  MAIN_AGENT_PROJECT_ID,
  agentSessionId,
  agentSessionUpdatedAt,
  agentSessionWorkingDirectory,
  effortLabel,
  formatAgentSessionWorkspace,
} from './model'
import type { AgentSessionHistoryItem, ProjectGroup, WorkspaceFileOpenTarget, WorkspaceView } from './types'

declare const __FARMING_PACKAGE_VERSION__: string

const DEFAULT_PROJECT_SESSION_LIMIT = 4
type SessionPreviewAnchorEvent = { currentTarget: HTMLElement }

type PinnedSidebarItem =
  | { kind: 'agent'; agent: Agent }
  | { kind: 'agent-session'; session: AgentSessionHistoryItem }

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

type FarmingUpdateStatus = {
  current?: {
    releaseVersion?: string
    packageVersion?: string
  }
  latest?: {
    version?: string
    assetName?: string
  }
  available?: boolean
  installable?: boolean
  blockingAgents?: Array<{ id: string; command: string; task?: string; cwd?: string }>
  state?: {
    phase?: string
    error?: string
  }
}

const ProjectFilesSection = lazy(() => import('../files/ProjectFilesSection').then(module => ({
  default: module.ProjectFilesSection,
})))

interface CodeSidebarProps {
  sidebarCollapsed: boolean
  activeView: WorkspaceView
  searchOpen: boolean
  searchQuery: string
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
  agentCreationWorkspace?: string
  openWorkspaceFile: OpenWorkspaceFile | null
  openWorkspaceFiles: OpenWorkspaceFile[]
  fileRevealRequest: { agentId: string; path: string; kind: 'directory' | 'file'; requestId: number } | null
  fileSearchFocusRequest: { agentId: string; requestId: number; query?: string } | null
  searchInputRef: RefObject<HTMLInputElement | null>
  projectListRef: RefObject<HTMLDivElement | null>
  onNewAgent: (workspace?: string, command?: string, returnFocusTarget?: HTMLElement | null) => void
  onToggleSidebar: () => void
  onOpenSearch: () => void
  onOpenWorkspaceView: (view: WorkspaceView) => void
  onOpenMainAgent: () => void
  onRestartMainAgent: (command: 'bash' | 'zsh' | 'codex' | 'claude') => void
  onSearchQueryChange: (value: string) => void
  onSearchKeyDown: (event: ReactKeyboardEvent<HTMLInputElement>) => void
  onCloseSearch: () => void
  onProjectListKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void
  onToggleProject: (projectId: string) => void
  onToggleProjectSessions: (projectId: string) => void
  onOpenProjectContextMenu: (event: ReactMouseEvent<HTMLElement>, projectId: string) => void
  onOpenProjectKeyboardMenu: (event: ReactKeyboardEvent<HTMLElement>, projectId: string) => void
  onOpenAgent: (agentId: string) => void
  onUpdateAgentFlags: (agent: Agent, flags: Partial<Pick<Agent, 'pinned' | 'archived'>>) => void
  onOpenAgentContextMenu: (event: ReactMouseEvent<HTMLElement>, agentId: string) => void
  onOpenAgentKeyboardMenu: (event: ReactKeyboardEvent<HTMLElement>, agentId: string) => void
  onResumeAgentSession: (provider: string, sessionId: string) => void
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
  searchQuery,
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
  agentCreationWorkspace,
  openWorkspaceFile,
  openWorkspaceFiles,
  fileRevealRequest,
  fileSearchFocusRequest,
  searchInputRef,
  projectListRef,
  onNewAgent,
  onToggleSidebar,
  onOpenSearch,
  onOpenWorkspaceView,
  onOpenMainAgent,
  onRestartMainAgent,
  onSearchQueryChange,
  onSearchKeyDown,
  onCloseSearch,
  onProjectListKeyDown,
  onToggleProject,
  onToggleProjectSessions,
  onOpenProjectContextMenu,
  onOpenProjectKeyboardMenu,
  onOpenAgent,
  onUpdateAgentFlags,
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
  const [sessionPreview, setSessionPreview] = useState<{
    session: AgentSessionHistoryItem
    x: number
    y: number
  } | null>(null)
  const [usageCollapsed, setUsageCollapsed] = useState(true)
  const [updateStatus, setUpdateStatus] = useState<FarmingUpdateStatus | null>(null)
  const [updateChecking, setUpdateChecking] = useState(false)
  const [updateError, setUpdateError] = useState('')
  const hideSessionPreview = () => setSessionPreview(null)
  const showSessionPreview = (event: SessionPreviewAnchorEvent, session: AgentSessionHistoryItem) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const width = 320
    const x = Math.min(window.innerWidth - width - 12, rect.right + 8)
    const y = Math.max(8, Math.min(rect.top - 4, window.innerHeight - 112))
    setSessionPreview({
      session,
      x: Math.max(12, x),
      y,
    })
  }
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
      const aTime = a.kind === 'agent'
        ? a.agent.lastActivity ?? a.agent.startedAt ?? 0
        : agentSessionUpdatedAt(a.session)
      const bTime = b.kind === 'agent'
        ? b.agent.lastActivity ?? b.agent.startedAt ?? 0
        : agentSessionUpdatedAt(b.session)
      return bTime - aTime
    })
  const visibleProjectSections = displayedProjects.filter(project => (
    project.agents.some(agent => !agent.pinned || !agent.isMain)
    || project.agentSessions.some(session => !session.pinned)
    || (project.hiddenAgentSessionCount ?? 0) > 0
  ))
  const refreshUpdateStatus = useCallback((force = false) => {
    setUpdateChecking(true)
    setUpdateError('')
    fetch(appPath(`/api/update${force ? '?force=1' : ''}`))
      .then(response => {
        if (!response.ok) {
          throw new Error(`Update check failed (${response.status})`)
        }
        return response.json()
      })
      .then((body: { update?: FarmingUpdateStatus }) => {
        setUpdateStatus(body.update ?? null)
      })
      .catch(error => {
        setUpdateError(error instanceof Error ? error.message : copy.updateFailed)
      })
      .finally(() => setUpdateChecking(false))
  }, [copy.updateFailed])
  const startUpgrade = useCallback(() => {
    const phase = updateStatus?.state?.phase || ''
    if (phase === 'downloading' || phase === 'extracting' || phase === 'installing') return
    if (!updateStatus?.available) {
      refreshUpdateStatus(true)
      return
    }

    setUpdateChecking(true)
    setUpdateError('')
    fetch(appPath('/api/update/install'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
      .then(response => response.json().then(body => ({ response, body })))
      .then(({ response, body }: { response: Response; body: { update?: FarmingUpdateStatus; error?: string; blockingAgents?: FarmingUpdateStatus['blockingAgents'] } }) => {
        if (!response.ok) {
          const blockers = body.blockingAgents || []
          const suffix = blockers.length > 0
            ? `: ${blockers.map(agent => agent.command).join(', ')}`
            : ''
          throw new Error(`${body.error || copy.updateFailed}${suffix}`)
        }
        setUpdateStatus(current => ({
          ...(current ?? {}),
          ...(body.update ?? {}),
        }))
      })
      .catch(error => {
        setUpdateError(error instanceof Error ? error.message : copy.updateFailed)
      })
      .finally(() => setUpdateChecking(false))
  }, [copy.updateFailed, refreshUpdateStatus, updateStatus?.available, updateStatus?.state?.phase])

  useEffect(() => {
    refreshUpdateStatus(false)
  }, [refreshUpdateStatus])

  const updatePhase = updateStatus?.state?.phase || ''
  const updateInstalling = updatePhase === 'downloading' || updatePhase === 'extracting' || updatePhase === 'installing'
  const updateBusy = updateInstalling || (updateChecking && Boolean(updateStatus?.available))
  const updateButtonLabel = updateBusy
    ? copy.updating
    : updateError
      ? copy.retryUpdate
      : updateStatus?.available
        ? copy.upgrade
        : ''
  const updateCollapsedLabel = updateBusy ? '…' : updateError ? '!' : updateStatus?.available ? '↑' : 'β'
  const currentVersion = compactProductVersion(updateStatus?.current?.releaseVersion || updateStatus?.current?.packageVersion || __FARMING_PACKAGE_VERSION__ || '')
  const currentVersionLabel = currentVersion ? `v${currentVersion}` : ''
  const updateTitle = updateError
    ? updateError
    : updateStatus?.available
      ? copy.upgradeToVersion(updateStatus.latest?.version || updateStatus.latest?.assetName || '')
      : copy.checkForUpdates

  return (
    <aside
      className={`code-sidebar ${sidebarCollapsed ? 'collapsed' : ''}`}
      data-testid="code-sidebar"
      onMouseLeave={hideSessionPreview}
    >
      <div className="code-nav">
        <div className="code-nav-top-row">
          <button
            type="button"
            className="code-nav-item primary"
            data-testid="code-new-agent"
            onClick={event => onNewAgent(agentCreationWorkspace, undefined, event.currentTarget)}
          >
            <span className="code-nav-icon">+</span>
            <span>{copy.newAgent}</span>
            {keyboardShortcutsEnabled && <kbd>N</kbd>}
          </button>
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
            />
          </button>
        </div>
        <button type="button" className={`code-nav-item ${activeView === 'search' || searchOpen ? 'active' : ''}`} data-testid="code-nav-search" onClick={onOpenSearch}>
          <span className="code-nav-icon">⌕</span>
          <span>{copy.search}</span>
          {keyboardShortcutsEnabled && <kbd>/</kbd>}
        </button>
        <button type="button" className={`code-nav-item ${activeView === 'history' ? 'active' : ''}`} data-testid="code-nav-history" onClick={() => onOpenWorkspaceView('history')}>
          <span className="code-nav-icon">
            <HistoryIcon />
          </span>
          <span>{copy.history}</span>
        </button>
      </div>

      {searchOpen && (
        <div className="code-search-box" data-testid="code-search-box">
          <span>⌕</span>
          <input
            ref={searchInputRef}
            value={searchQuery}
            onChange={event => onSearchQueryChange(event.target.value)}
            onKeyDown={onSearchKeyDown}
            placeholder={copy.searchProjectsOrAgents}
            aria-label={copy.searchProjectsOrAgents}
          />
          <button type="button" onClick={onCloseSearch} aria-label={copy.clearSearch}>×</button>
        </div>
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
            activeTerminalId={activeTerminalId}
            selectedSearchAgentId={selectedSearchAgentId}
            selectedSearchSessionHandle={selectedSearchSessionHandle}
            claimedAgentSessionKeyByAgentId={claimedAgentSessionKeyByAgentId}
            agentShortcutKeys={agentShortcutKeys}
            keyboardShortcutsEnabled={keyboardShortcutsEnabled}
            now={now}
            onOpenAgent={onOpenAgent}
            onUpdateAgentFlags={onUpdateAgentFlags}
            onOpenAgentContextMenu={onOpenAgentContextMenu}
            onOpenAgentKeyboardMenu={onOpenAgentKeyboardMenu}
            onResumeAgentSession={onResumeAgentSession}
            onOpenAgentSessionContextMenu={onOpenAgentSessionContextMenu}
            onOpenAgentSessionKeyboardMenu={onOpenAgentSessionKeyboardMenu}
            onShowAgentSessionPreview={showSessionPreview}
            onHideAgentSessionPreview={hideSessionPreview}
            copy={copy}
          />
        )}
        {visibleProjectSections.map(project => (
          <ProjectSection
            key={project.id}
            project={project}
            collapsed={collapsedProjectIds.has(project.id) && !normalizedSearch}
            activeTerminalId={activeTerminalId}
            selectedSearchAgentId={selectedSearchAgentId}
            selectedSearchSessionHandle={selectedSearchSessionHandle}
            claimedAgentSessionKeyByAgentId={claimedAgentSessionKeyByAgentId}
            agentShortcutKeys={agentShortcutKeys}
            keyboardShortcutsEnabled={keyboardShortcutsEnabled}
            now={now}
            openWorkspaceFile={openWorkspaceFile}
            openWorkspaceFiles={openWorkspaceFiles}
            fileRevealRequest={fileRevealRequest}
            fileSearchFocusRequest={fileSearchFocusRequest}
            onToggleProject={onToggleProject}
            onToggleProjectSessions={onToggleProjectSessions}
            onOpenProjectContextMenu={onOpenProjectContextMenu}
            onOpenProjectKeyboardMenu={onOpenProjectKeyboardMenu}
            onOpenAgent={onOpenAgent}
            onUpdateAgentFlags={onUpdateAgentFlags}
            onOpenAgentContextMenu={onOpenAgentContextMenu}
            onOpenAgentKeyboardMenu={onOpenAgentKeyboardMenu}
            onResumeAgentSession={onResumeAgentSession}
            onOpenAgentSessionContextMenu={onOpenAgentSessionContextMenu}
            onOpenAgentSessionKeyboardMenu={onOpenAgentSessionKeyboardMenu}
            onShowAgentSessionPreview={showSessionPreview}
            onHideAgentSessionPreview={hideSessionPreview}
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
            className={`code-product-mark ${updateStatus?.available ? 'upgrade' : ''} ${updateBusy ? 'busy' : ''} ${updateError ? 'error' : ''}`}
            data-testid="code-product-mark"
            title={updateTitle}
            aria-label={updateTitle}
            onClick={startUpgrade}
            disabled={updateBusy}
          >
            <span className="code-product-mark-copy">
              <span className="code-product-mark-main">Farming Code</span>
              {currentVersionLabel && (
                <span className="code-product-mark-badge">DOGFOOD BETA · {currentVersionLabel}</span>
              )}
            </span>
            {updateButtonLabel && <span className="code-product-mark-update">{updateButtonLabel}</span>}
            <span className="code-product-mark-collapsed" aria-hidden="true">{updateCollapsedLabel}</span>
          </button>
          <button
            type="button"
            className="code-sidebar-options"
            data-testid="code-sidebar-options"
            aria-label={copy.openOptions}
            title={copy.openOptions}
            onClick={onOpenOptionsMenu}
          >
            ◐
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
                now={now}
                onToggleCollapsed={() => setUsageCollapsed(collapsed => !collapsed)}
                onOpenMainAgent={onOpenMainAgent}
                onRestartMainAgent={onRestartMainAgent}
              />
            )}
          </>
        )}
      </div>
      {sessionPreview && (
        <AgentSessionPreview
          session={sessionPreview.session}
          now={now}
          x={sessionPreview.x}
          y={sessionPreview.y}
        />
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

function formatResetTime(value: number | null | undefined, now: number) {
  const resetAt = Number(value)
  if (!Number.isFinite(resetAt) || resetAt <= 0) return ''
  const date = new Date(resetAt)
  const current = new Date(now)
  const sameDay = date.toDateString() === current.toDateString()
  return new Intl.DateTimeFormat(undefined, sameDay
    ? { hour: 'numeric', minute: '2-digit' }
    : { month: 'short', day: 'numeric' }
  ).format(date)
}

function formatPercent(value: number | null | undefined) {
  const percent = Number(value)
  if (!Number.isFinite(percent)) return '--'
  return `${Math.round(percent)}%`
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

function formatCollapsedUsageSummary(tokenRate: number | null, systemStats: SystemStats | null) {
  const parts: string[] = []

  if (tokenRate !== null) {
    parts.push(formatTokenRate(tokenRate))
  }

  if (systemStats) {
    parts.push(`CPU ${systemStats.cpu}% / MEM ${systemStats.memory.percentage}%`)
  }

  return parts.join(' · ') || '5m'
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
  now,
  onToggleCollapsed,
  onOpenMainAgent,
  onRestartMainAgent,
}: {
  collapsed: boolean
  mainAgent: Agent | null
  usageSummary: UsageSummary | null
  systemStats: SystemStats | null
  now: number
  onToggleCollapsed: () => void
  onOpenMainAgent: () => void
  onRestartMainAgent: (command: 'bash' | 'zsh' | 'codex' | 'claude') => void
}) {
  const localTokenRate = providerLocalTokenRate(usageSummary)
  const collapsedSummary = formatCollapsedUsageSummary(localTokenRate, systemStats)
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
          <span className={`code-usage-chevron ${collapsed ? '' : 'expanded'}`} aria-hidden="true" />
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
                    ['bash', 'bash'],
                    ['zsh', 'zsh'],
                    ['codex', 'Codex'],
                    ['claude', 'Claude Code'],
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
            <ProviderUsage key={provider.provider} provider={provider} now={now} />
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
  now,
}: {
  provider: UsageProviderSummary
  now: number
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
            <div className="code-usage-row code-usage-subrow" title={quotaTitle}>
              <span>{formatUsageWindow(primary.windowMinutes)}</span>
              <strong>{formatPercent(primary.usedPercent)} {formatResetTime(primary.resetsAt, now)}</strong>
            </div>
          )}
          {secondary && (
            <div className="code-usage-row code-usage-subrow" title={quotaTitle}>
              <span>{formatUsageWindow(secondary.windowMinutes)}</span>
              <strong>{formatPercent(secondary.usedPercent)} {formatResetTime(secondary.resetsAt, now)}</strong>
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

interface PinnedSectionProps {
  items: PinnedSidebarItem[]
  activeTerminalId: string | null
  selectedSearchAgentId: string | null
  selectedSearchSessionHandle: string | null
  claimedAgentSessionKeyByAgentId: ReadonlyMap<string, string>
  agentShortcutKeys: Map<string, string>
  keyboardShortcutsEnabled: boolean
  now: number
  onOpenAgent: (agentId: string) => void
  onUpdateAgentFlags: (agent: Agent, flags: Partial<Pick<Agent, 'pinned' | 'archived'>>) => void
  onOpenAgentContextMenu: (event: ReactMouseEvent<HTMLElement>, agentId: string) => void
  onOpenAgentKeyboardMenu: (event: ReactKeyboardEvent<HTMLElement>, agentId: string) => void
  onResumeAgentSession: (provider: string, sessionId: string) => void
  onOpenAgentSessionContextMenu: (event: ReactMouseEvent<HTMLElement>, provider: string, sessionId: string) => void
  onOpenAgentSessionKeyboardMenu: (event: ReactKeyboardEvent<HTMLElement>, provider: string, sessionId: string) => void
  onShowAgentSessionPreview: (event: SessionPreviewAnchorEvent, session: AgentSessionHistoryItem) => void
  onHideAgentSessionPreview: () => void
  copy: CodeCopy
}

function PinnedSection({
  items,
  activeTerminalId,
  selectedSearchAgentId,
  selectedSearchSessionHandle,
  claimedAgentSessionKeyByAgentId,
  agentShortcutKeys,
  keyboardShortcutsEnabled,
  now,
  onOpenAgent,
  onUpdateAgentFlags,
  onOpenAgentContextMenu,
  onOpenAgentKeyboardMenu,
  onResumeAgentSession,
  onOpenAgentSessionContextMenu,
  onOpenAgentSessionKeyboardMenu,
  onShowAgentSessionPreview,
  onHideAgentSessionPreview,
  copy,
}: PinnedSectionProps) {
  return (
    <section className="code-pinned-section" data-testid="code-pinned-section">
      <div className="code-pinned-title">{copy.pinned}</div>
      <div className="code-agent-list code-pinned-list">
        {items.map(item => {
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
                onOpenAgentContextMenu={onOpenAgentContextMenu}
                onOpenAgentKeyboardMenu={onOpenAgentKeyboardMenu}
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
              onShowPreview={onShowAgentSessionPreview}
              onHidePreview={onHideAgentSessionPreview}
              copy={copy}
            />
          )
        })}
      </div>
    </section>
  )
}

interface ProjectSectionProps {
  project: ProjectGroup
  collapsed: boolean
  activeTerminalId: string | null
  selectedSearchAgentId: string | null
  selectedSearchSessionHandle: string | null
  claimedAgentSessionKeyByAgentId: ReadonlyMap<string, string>
  agentShortcutKeys: Map<string, string>
  keyboardShortcutsEnabled: boolean
  now: number
  openWorkspaceFile: OpenWorkspaceFile | null
  openWorkspaceFiles: OpenWorkspaceFile[]
  fileRevealRequest: { agentId: string; path: string; kind: 'directory' | 'file'; requestId: number } | null
  fileSearchFocusRequest: { agentId: string; requestId: number; query?: string } | null
  onToggleProject: (projectId: string) => void
  onToggleProjectSessions: (projectId: string) => void
  onOpenProjectContextMenu: (event: ReactMouseEvent<HTMLElement>, projectId: string) => void
  onOpenProjectKeyboardMenu: (event: ReactKeyboardEvent<HTMLElement>, projectId: string) => void
  onOpenAgent: (agentId: string) => void
  onUpdateAgentFlags: (agent: Agent, flags: Partial<Pick<Agent, 'pinned' | 'archived'>>) => void
  onOpenAgentContextMenu: (event: ReactMouseEvent<HTMLElement>, agentId: string) => void
  onOpenAgentKeyboardMenu: (event: ReactKeyboardEvent<HTMLElement>, agentId: string) => void
  onResumeAgentSession: (provider: string, sessionId: string) => void
  onOpenAgentSessionContextMenu: (event: ReactMouseEvent<HTMLElement>, provider: string, sessionId: string) => void
  onOpenAgentSessionKeyboardMenu: (event: ReactKeyboardEvent<HTMLElement>, provider: string, sessionId: string) => void
  onShowAgentSessionPreview: (event: SessionPreviewAnchorEvent, session: AgentSessionHistoryItem) => void
  onHideAgentSessionPreview: () => void
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
  activeTerminalId,
  selectedSearchAgentId,
  selectedSearchSessionHandle,
  claimedAgentSessionKeyByAgentId,
  agentShortcutKeys,
  keyboardShortcutsEnabled,
  now,
  openWorkspaceFile,
  openWorkspaceFiles,
  fileRevealRequest,
  fileSearchFocusRequest,
  onToggleProject,
  onToggleProjectSessions,
  onOpenProjectContextMenu,
  onOpenProjectKeyboardMenu,
  onOpenAgent,
  onUpdateAgentFlags,
  onOpenAgentContextMenu,
  onOpenAgentKeyboardMenu,
  onResumeAgentSession,
  onOpenAgentSessionContextMenu,
  onOpenAgentSessionKeyboardMenu,
  onShowAgentSessionPreview,
  onHideAgentSessionPreview,
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
  const projectFileAgent = project.agents.find(agent => !agent.isMain) ?? null
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
          <span className={`code-folder-icon ${collapsed ? 'collapsed' : 'expanded'}`} aria-hidden="true" />
          <span>{project.name}</span>
        </button>
      </div>
      {!collapsed && (
        <div className="code-project-expanded">
          {showAgentsSection && (
            <div ref={agentsSectionRef} className="code-agents-section" data-testid="code-agents-section" data-project-id={project.id}>
              <div className="code-agent-list">
                {sortedAgents.map(agent => {
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
                      onOpenAgentContextMenu={onOpenAgentContextMenu}
                      onOpenAgentKeyboardMenu={onOpenAgentKeyboardMenu}
                      copy={copy}
                    />
                  )
                })}
                {visibleAgentSessions.map(session => (
                  <AgentRow
                    key={agentRowKey({ kind: 'history', session })}
                    session={session}
                    searchSelected={agentSessionId(session) === selectedSearchSessionHandle}
                    now={now}
                    onResume={onResumeAgentSession}
                    onOpenSessionContextMenu={onOpenAgentSessionContextMenu}
                    onOpenSessionKeyboardMenu={onOpenAgentSessionKeyboardMenu}
                    onShowPreview={onShowAgentSessionPreview}
                    onHidePreview={onHideAgentSessionPreview}
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
                agentId={projectFileAgent.id}
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
                onMoveEntries={onMoveWorkspaceEntries}
                onDeleteEntries={onDeleteWorkspaceEntries}
                copy={copy}
              />
            </Suspense>
          )}
        </div>
      )}
    </section>
  )
}

function AgentSessionPreview({
  session,
  now,
  x,
  y,
}: {
  session: AgentSessionHistoryItem
  now: number
  x: number
  y: number
}) {
  const title = session.title || `${session.providerName || 'Agent'} session`
  const provider = session.providerName || session.provider
  const workspace = formatAgentSessionWorkspace(session)
  const workingDirectory = agentSessionWorkingDirectory(session)
  const modelLine = session.model
    ? `${provider} · ${session.model}${session.effort ? ` · ${effortLabel(session.effort)}` : ''}`
    : provider

  return (
    <div
      className="code-session-preview"
      data-testid="code-session-preview"
      style={{ left: x, top: y }}
      aria-hidden="true"
    >
      <div className="code-session-preview-header">
        <strong>{title}</strong>
        <span title={session.updatedAt ? new Date(session.updatedAt).toLocaleString() : undefined}>
          {formatRelativeAge(agentSessionUpdatedAt(session), now)}
        </span>
      </div>
      <div className="code-session-preview-line">
        <span className="code-session-preview-icon">▣</span>
        <span>{workspace}</span>
      </div>
      <div className="code-session-preview-line">
        <span className="code-session-preview-icon">⌁</span>
        <span>{modelLine}</span>
      </div>
      {workingDirectory && workingDirectory !== session.workspace && (
        <div className="code-session-preview-line">
          <span className="code-session-preview-icon">↗</span>
          <span>{workingDirectory}</span>
        </div>
      )}
    </div>
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
  onOpenAgentContextMenu?: (event: ReactMouseEvent<HTMLElement>, agentId: string) => void
  onOpenAgentKeyboardMenu?: (event: ReactKeyboardEvent<HTMLElement>, agentId: string) => void
  onResume?: (provider: string, sessionId: string) => void
  onOpenSessionContextMenu?: (event: ReactMouseEvent<HTMLElement>, provider: string, sessionId: string) => void
  onOpenSessionKeyboardMenu?: (event: ReactKeyboardEvent<HTMLElement>, provider: string, sessionId: string) => void
  onShowPreview?: (event: SessionPreviewAnchorEvent, session: AgentSessionHistoryItem) => void
  onHidePreview?: () => void
  copy: CodeCopy
}) {
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
  const openRow = () => {
    if (requiresResume) {
      onHidePreview?.()
      if (sessionProvider && sessionId) onResume?.(sessionProvider, sessionId)
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

  return (
    <div
      tabIndex={0}
      className={`code-agent-row ${requiresResume ? 'requires-resume' : ''} ${active ? 'active' : ''} ${searchSelected ? 'search-selected' : ''} ${rowState.pinned ? 'pinned' : ''} ${rowState.unread ? 'unread' : ''}`}
      data-testid={rowTestId}
      data-agent-id={agent?.id}
      data-provider={session?.provider}
      data-session-id={session?.id}
      aria-label={rowState.title}
      onClick={openRow}
      onMouseEnter={event => {
        if (session) onShowPreview?.(event, session)
      }}
      onMouseLeave={onHidePreview}
      onContextMenu={event => {
        if (requiresResume) {
          onHidePreview?.()
          if (sessionProvider && sessionId) onOpenSessionContextMenu?.(event, sessionProvider, sessionId)
          return
        }
        if (liveAgentId) onOpenAgentContextMenu?.(event, liveAgentId)
      }}
      onKeyDown={event => {
        if (requiresResume) {
          if (sessionProvider && sessionId) onOpenSessionKeyboardMenu?.(event, sessionProvider, sessionId)
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
      <span className="code-agent-row-copy">
        <span className="code-agent-name">{rowState.title}</span>
      </span>
      <span className="code-agent-row-trailing">
        {rowState.statusIndicatorVisible && (
          <span className={`code-agent-dot ${rowState.lifecycleStatus} ${rowState.turnActive ? 'turn-active' : ''}`} />
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
        {rowState.ageVisible && (
          <span className="code-agent-age" title={rowState.ageTitle}>
            {rowState.ageLabel}
          </span>
        )}
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
              <AgentPinIcon />
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
        {shortcutHint && <kbd>{shortcutHint}</kbd>}
      </span>
    </div>
  )
}
