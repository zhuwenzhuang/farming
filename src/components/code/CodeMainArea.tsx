import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ComponentProps, type CSSProperties, type Dispatch, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type RefObject, type SetStateAction, type SyntheticEvent as ReactSyntheticEvent } from 'react'
import type { Agent, TaskHistoryEntry } from '@/types/agent'
import { isAcpRuntime } from '@/lib/agent-runtime'
import { agentTitle } from '@/lib/format'
import type { TerminalPathOpenTarget } from '@/lib/terminal-session-pool'
import type {
  OpenWorkspaceFile,
  WorkspaceOpenFileTarget,
  WorkspaceOpenFileUpdater,
} from '@/lib/workspace-open-files'
import type { WorkspaceFileResolveOptions } from '@/lib/workspace-file-model-manager'
import type { WorkspaceFile } from '@/lib/workspace-files'
import type { WorkspaceNavigationFileInput } from '@/lib/workspace-navigation-history'
import type { WorkspaceShareTarget } from '@/lib/workspace-share-target'
import { isCompactViewport, isTouchInputViewport } from '@/lib/responsive-mode'
import type { UiPreferences } from '@/lib/ui-preferences'
import { isWorkspaceHtmlFile, isWorkspaceMarkdownFile, isWorkspaceSvgFile } from '@/lib/workspace-editor-model'
import { BrowserActivityPreview } from '../../../extensions/browser/frontend/BrowserActivityPreview'
import { BrowserViewer } from '../../../extensions/browser/frontend/BrowserViewer'
import type { BrowserResource } from '../../../extensions/browser/frontend/types'
import type { BrowserResourcesController } from '../../../extensions/browser/frontend/useBrowserResources'
import { ComputerViewer } from '../../../extensions/computer/frontend/ComputerViewer'
import type { ComputerResource } from '../../../extensions/computer/frontend/types'
import type { ComputerResourcesController } from '../../../extensions/computer/frontend/useComputerResources'
import { AgentWorkPane } from './AgentWorkPane'
import { AgentPlanActivityPreview } from './AgentActivityDock'
import type { AgentTranscriptProcessItem } from './acp/acp-entry-projection'
import { CodeComposer } from './CodeComposer'
import { AcpComposer } from './acp/AcpComposer'
import { HistoryPanel } from './HistoryPanel'
import type { ShareNoticeAnchor } from './share-notice'
import { SearchPanel } from './SearchPanel'
import type { GlobalWorkspaceFileSearchMatch } from './useGlobalWorkspaceFileSearch'
import {
  ChevronDownGlyph,
  ChevronUpGlyph,
  FocusModeGlyph,
  HistoryGlyph,
  NewAgentGlyph,
  PuzzleGlyph,
  SearchGlyph,
  ShareGlyph,
} from '../IconGlyphs'
import type { CodeCopy } from './copy'
import type { AgentSessionHistoryItem, ProjectGroup, WorkspaceFileOpenTarget, WorkspaceSearchScope, WorkspaceSearchCounts, WorkspaceView } from './types'
import { PluginsPanel, type AgentHomeFileTarget, type PluginsNavigationState } from './PluginsPanel'

type ComposerProps = Omit<ComponentProps<typeof CodeComposer>, 'copy'>
type AcpComposerProps = Omit<ComponentProps<typeof AcpComposer>, 'copy'>
type TerminalFollowState = {
  following: boolean
  hasUnreadOutput: boolean
}

const TERMINAL_COMPOSER_COLLAPSED_STORAGE_KEY = 'farming.code.terminalComposerCollapsed.v1'
const RESOURCE_AGENT_PANEL_OPEN_STORAGE_KEY = 'farming.code.resourceAgentPanelOpen.v1'
const DEFAULT_RESOURCE_AGENT_WIDTH = 420
const MIN_RESOURCE_AGENT_WIDTH = 360
const MAX_RESOURCE_AGENT_WIDTH = 800
const MIN_RESOURCE_WORKSPACE_WIDTH = 320

function readTerminalComposerCollapsed() {
  try {
    const stored = window.localStorage.getItem(TERMINAL_COMPOSER_COLLAPSED_STORAGE_KEY)
    return stored === 'true'
  } catch {
    return false
  }
}

function writeTerminalComposerCollapsed(collapsed: boolean) {
  try {
    window.localStorage.setItem(TERMINAL_COMPOSER_COLLAPSED_STORAGE_KEY, String(collapsed))
  } catch {
    // The in-memory preference still applies when local storage is unavailable.
  }
}

function readResourceAgentPanelOpen() {
  try {
    return window.localStorage.getItem(RESOURCE_AGENT_PANEL_OPEN_STORAGE_KEY) === 'true'
  } catch {
    return false
  }
}

function writeResourceAgentPanelOpen(open: boolean) {
  try {
    window.localStorage.setItem(RESOURCE_AGENT_PANEL_OPEN_STORAGE_KEY, String(open))
  } catch {
    // The in-memory preference still applies when local storage is unavailable.
  }
}

function maxResourceAgentWidth(mainWidth: number) {
  return Math.max(
    MIN_RESOURCE_AGENT_WIDTH,
    Math.min(MAX_RESOURCE_AGENT_WIDTH, mainWidth - MIN_RESOURCE_WORKSPACE_WIDTH - 1),
  )
}

function clampResourceAgentWidth(width: number, mainWidth: number) {
  return Math.max(MIN_RESOURCE_AGENT_WIDTH, Math.min(maxResourceAgentWidth(mainWidth), width))
}

function supportsComposerCollapse() {
  return typeof window !== 'undefined'
    && window.matchMedia('(hover: hover) and (pointer: fine)').matches
    && !isCompactViewport()
}

function replacesAgent(agent: Agent | null, previousAgentId: string | null) {
  if (!agent || !previousAgentId) return false
  return agent.id === previousAgentId
    || agent.restartedFromAgentId === previousAgentId
    || agent.restartedFromAgentIds?.includes(previousAgentId) === true
}

const FILE_EDITOR_CHUNK_RECOVERY_KEY = 'farming.code.fileEditor.chunk-recovery'
type FileEditorPaneComponent = typeof import('../files/FileEditorPane')['FileEditorPane']
type LoadedFileEditorPane = { default: FileEditorPaneComponent }

let fileEditorPaneLoadPromise: Promise<LoadedFileEditorPane> | null = null
let loadedFileEditorPane: FileEditorPaneComponent | null = null

function reloadAfterFileEditorChunkLoadFailure() {
  if (typeof window === 'undefined') return false
  try {
    if (window.sessionStorage.getItem(FILE_EDITOR_CHUNK_RECOVERY_KEY) === '1') return false
    window.sessionStorage.setItem(FILE_EDITOR_CHUNK_RECOVERY_KEY, '1')
    window.location.reload()
    return true
  } catch {
    return false
  }
}

function loadFileEditorPaneModule() {
  if (!fileEditorPaneLoadPromise) {
    fileEditorPaneLoadPromise = import('../files/FileEditorPane').then(module => {
      try {
        window.sessionStorage.removeItem(FILE_EDITOR_CHUNK_RECOVERY_KEY)
      } catch {
        // The editor is available even when session storage is unavailable.
      }
      loadedFileEditorPane = module.FileEditorPane
      return { default: loadedFileEditorPane }
    })
  }
  return fileEditorPaneLoadPromise
}

function loadFileEditorPane() {
  return loadFileEditorPaneModule().catch(error => {
    if (reloadAfterFileEditorChunkLoadFailure()) return new Promise<never>(() => {})
    throw error
  })
}

function basename(filePath: string) {
  return filePath.split('/').filter(Boolean).pop() || filePath
}

function pathSegments(filePath: string) {
  return filePath.split('/').filter(Boolean)
}

function workspaceLabel(workspaceRoot: string | undefined) {
  if (!workspaceRoot) return ''
  return workspaceRoot.replace(/\\/g, '/').split('/').filter(Boolean).pop() || '/'
}

function FileEditorFallback({
  openFile,
  onChangeDraft,
  readOnly,
  copy,
}: {
  openFile: OpenWorkspaceFile
  onChangeDraft: (draft: string) => void
  readOnly: boolean
  copy: CodeCopy
}) {
  const segments = pathSegments(openFile.file.path)
  const projectLabel = workspaceLabel(openFile.workspaceRoot)
  const showBreadcrumbs = !openFile.file.preview
    && !isWorkspaceMarkdownFile(openFile.file.path)
    && !isWorkspaceHtmlFile(openFile.file.path)
    && !isWorkspaceSvgFile(openFile.file.path)
  const breadcrumbTitle = openFile.workspaceRoot
    ? `${openFile.workspaceRoot.replace(/[\\/]+$/, '')}/${openFile.file.path}`
    : openFile.file.path

  return (
    <section
      className="code-file-editor fallback"
      data-testid="code-file-editor"
      aria-label={copy.editorFor(openFile.file.path)}
    >
      <header className="code-file-editor-header">
        <div className="code-file-editor-tab-strip">
          <div className="code-file-editor-tabs" role="tablist">
            <div
              className={`code-file-editor-tab active ${openFile.dirty ? 'dirty' : ''} ${openFile.externalChanged ? 'warning' : ''}`}
              title={openFile.file.path}
              role="tab"
              aria-selected="true"
            >
              <span aria-hidden="true" />
              <span className="code-file-editor-tab-name">{basename(openFile.file.path)}</span>
              <span className="code-file-editor-tab-tail">
                {(openFile.dirty || openFile.externalChanged) && (
                  <span className="code-file-editor-dirty" title={openFile.externalChanged ? copy.changedOnDisk : copy.unsavedChanges} />
                )}
              </span>
            </div>
          </div>
        </div>
        {showBreadcrumbs && (
          <div className="code-file-editor-bar">
            <nav className="code-file-editor-breadcrumbs" title={breadcrumbTitle} aria-label={copy.filePath}>
              {projectLabel && (
                <span className="code-file-editor-breadcrumb root">
                  <span className="code-file-editor-breadcrumb-name">{projectLabel}</span>
                  <span className="code-file-editor-breadcrumb-separator" aria-hidden="true" />
                </span>
              )}
              {segments.map((segment, index) => (
                <span
                  key={`${index}-${segment}`}
                  className={`code-file-editor-breadcrumb ${index === segments.length - 1 ? 'current' : ''}`}
                >
                  <span className="code-file-editor-breadcrumb-name">{segment}</span>
                  {index < segments.length - 1 && (
                    <span className="code-file-editor-breadcrumb-separator" aria-hidden="true" />
                  )}
                </span>
              ))}
            </nav>
            <div className="code-file-editor-actions">
              {openFile.dirty && <span className="code-file-editor-status">{copy.unsavedChanges}</span>}
            </div>
          </div>
        )}
      </header>
      <textarea
        className="code-file-editor-fallback-textarea"
        data-testid="code-file-editor-fallback-textarea"
        name="farming-file-editor-fallback"
        inputMode="text"
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="none"
        value={openFile.draft}
        onChange={event => onChangeDraft(event.currentTarget.value)}
        readOnly={readOnly}
        spellCheck={false}
        data-lpignore="true"
        data-1p-ignore="true"
        data-bwignore="true"
        data-form-type="other"
        aria-label={copy.editorFor(openFile.file.path)}
      />
    </section>
  )
}

interface CodeMainAreaProps {
  inert?: boolean
  readOnly: boolean
  activeView: WorkspaceView
  activeBrowserResource: BrowserResource | null
  browserController: BrowserResourcesController
  onBackFromBrowser: () => void
  onOpenBrowserResource: (resource: BrowserResource) => void
  activeComputerResource: ComputerResource | null
  computerController: ComputerResourcesController
  onBackFromComputer: () => void
  language: UiPreferences['language']
  showFileEditor: boolean
  openWorkspaceFile: OpenWorkspaceFile | null
  openWorkspaceFiles: OpenWorkspaceFile[]
  retainedWorkspaceFileModels: OpenWorkspaceFile[]
  openAgentsCount: number
  openAgents: Agent[]
  activeTerminalId: string | null
  resourceAgentId: string | null
  permissionSwitchingAgentId: string | null
  agentSwitchingKind: 'permission' | 'runtime' | null
  terminalFocusRequest: { agentId: string; nonce: number } | null
  agentCreationWorkspace?: string
  displayedProjects: ProjectGroup[]
  searchQuery: string
  searchHasQuery: boolean
  searchLoading: boolean
  searchScope: WorkspaceSearchScope
  searchCounts: WorkspaceSearchCounts
  onSearchScopeChange: (scope: WorkspaceSearchScope) => void
  globalFileSearchLoading: boolean
  visibleSearchTargetCount: number
  selectedSearchAgentId: string | null
  selectedSearchSessionHandle: string | null
  selectedSearchFileKey: string | null
  globalFileSearchMatches: GlobalWorkspaceFileSearchMatch[]
  globalFileSearchFailedProjectCount: number
  globalFileSearchIncomplete: boolean
  globalFileSearchQueryTooLong: boolean
  globalFileOpenError: string | null
  globalFileOpeningKey: string | null
  searchInputRef: RefObject<HTMLInputElement | null>
  archivedRuns: TaskHistoryEntry[]
  archivedAgents: Agent[]
  historyAgentSessions: AgentSessionHistoryItem[]
  openHistorySessionKeys: ReadonlySet<string>
  historyAgentSessionsLoading: boolean
  historyAgentSessionsError: string
  providerSessionTotal: number | null
  historySessionRevealRequest: { requestId: number; sessionHandle: string; sessionId: string } | null
  canLoadMoreHistoryAgentSessions: boolean
  now: number
  composerProps: ComposerProps
  acpComposerProps: AcpComposerProps
  onNewAgent: (workspace?: string, command?: string) => void
  onOpenHistory: () => void
  onOpenPlugins: () => void
  pluginsNavigationState: PluginsNavigationState
  onPluginsNavigationStateChange: Dispatch<SetStateAction<PluginsNavigationState>>
  onOpenAgentHomeConfiguration: (target: AgentHomeFileTarget) => void
  onOpenSearch: () => void
  onOpenShare: () => void
  onOpenAppMode: () => void
  onOpenTerminal: (agentId: string, options?: { focusTerminal?: boolean }) => void
  onOpenTerminalPath: (agentId: string, target: TerminalPathOpenTarget) => void
  onResolveTerminalPath: (agentId: string, target: TerminalPathOpenTarget) => Promise<TerminalPathOpenTarget | null> | TerminalPathOpenTarget | null
  onSearchTerminalWord: (agentId: string, query: string) => void
  onTerminalFollowOutputChange?: (agentId: string, state: TerminalFollowState) => void
  onAgentReadLatest: (
    agentId: string,
    readCut?: { runtimeEpoch: string; outputSeq: number } | null,
  ) => void
  onRuntimeModeChange: (agentId: string, mode: 'terminal' | 'chat') => void
  onForkAgent: (
    agentId: string,
    mode: 'same-worktree' | 'new-worktree',
    options?: { targetRuntime?: 'chat'; expectedRevision?: number }
  ) => Promise<void> | void
  onReviewAndCommit: (agentId: string) => void
  onSessionOutput: (agentId: string, handler: (data: string, replace?: boolean, outputSeq?: number | null, runtimeEpoch?: string, stateRevision?: number | null, cols?: number, rows?: number, kind?: 'output' | 'resize' | 'clear') => void) => () => void
  onOpenSearchAgent: (agentId: string) => void
  onOpenSearchSession: (session: AgentSessionHistoryItem) => void
  onOpenSearchFile: (match: GlobalWorkspaceFileSearchMatch) => void
  onRetryGlobalFileSearch: () => void
  onSearchQueryChange: (value: string) => void
  onSearchKeyDown: (event: ReactKeyboardEvent<HTMLInputElement>) => void
  onCloseSearch: () => void
  onBackToProjects: () => void
  onLoadMoreHistoryAgentSessions: () => boolean | Promise<boolean>
  onSearchHistoryAgentSessions: (query: string, signal: AbortSignal) => Promise<AgentSessionHistoryItem[]>
  onResumeHistorySession: (provider: string, sessionId: string, providerHomeId?: string) => void
  onContinueArchivedRun: (entry: TaskHistoryEntry) => void
  onOpenArchivedAgent: (agentId: string) => void
  onRestoreArchivedAgent: (agentId: string) => void
  onChangeWorkspaceFileDraft: (draft: string) => void
  onUpdateOpenWorkspaceFile: (
    target: WorkspaceOpenFileTarget,
    updater: WorkspaceOpenFileUpdater
  ) => OpenWorkspaceFile | null
  onResolveWorkspaceFile: (
    rootId: string,
    filePath: string,
    options?: WorkspaceFileResolveOptions,
  ) => Promise<WorkspaceFile>
  onSelectOpenWorkspaceFile: (agentId: string, filePath: string, target?: WorkspaceFileOpenTarget) => boolean
  onOpenWorkspaceFilePath: (agentId: string, filePath: string, target?: WorkspaceFileOpenTarget) => Promise<void> | void
  onCopyReadOnlyShareLink: (target: WorkspaceShareTarget | null, anchor: ShareNoticeAnchor) => Promise<void> | void
  onOpenUrlInFarming?: (agentId: string, url: string) => void
  canNavigateWorkspaceBack: boolean
  canNavigateWorkspaceForward: boolean
  onNavigateWorkspaceHistory: (direction: -1 | 1) => boolean
  onCloseOpenWorkspaceFile: (agentId: string, filePath: string, workspaceRoot?: string) => void
  onCloseOpenWorkspaceFiles: (targets: WorkspaceOpenFileTarget[]) => void
  onReorderOpenWorkspaceFile: (sourceKey: string, targetKey: string, position: 'before' | 'after') => void
  onRevealWorkspaceFileInExplorer: (agentId: string, filePath: string, kind: 'directory' | 'file') => void
  onFocusWorkspaceFilesSearch: (agentId: string) => void
  onRecordWorkspaceNavigationCursor: (input: WorkspaceNavigationFileInput) => void
  onBackToAgentFromFile: (agentId: string) => void
  copy: CodeCopy
}

function viewTitle(copy: CodeCopy, view: WorkspaceView) {
  if (view === 'search') return copy.search
  if (view === 'history') return copy.history
  if (view === 'plugins') return copy.plugins
  return 'Farming'
}

type EmptyWorkspaceAction = 'history' | 'new-agent' | 'plugins' | 'search' | 'share' | 'focus'

function EmptyWorkspaceActionGlyph({ action }: { action: EmptyWorkspaceAction }) {
  if (action === 'new-agent') return <NewAgentGlyph />
  if (action === 'plugins') return <PuzzleGlyph />
  if (action === 'search') return <SearchGlyph />
  if (action === 'history') return <HistoryGlyph />
  if (action === 'share') return <ShareGlyph />
  return <FocusModeGlyph />
}

function EmptyWorkspaceGuide({
  agentCreationWorkspace,
  onNewAgent,
  onOpenHistory,
  onOpenPlugins,
  onOpenSearch,
  onOpenShare,
  onOpenAppMode,
  copy,
}: {
  agentCreationWorkspace?: string
  onNewAgent: (workspace?: string, command?: string) => void
  onOpenHistory: () => void
  onOpenPlugins: () => void
  onOpenSearch: () => void
  onOpenShare: () => void
  onOpenAppMode: () => void
  copy: CodeCopy
}) {
  const homeRef = useRef<HTMLDivElement>(null)
  const originBraceRef = useRef<HTMLSpanElement>(null)
  const targetBraceRef = useRef<HTMLSpanElement>(null)
  const [connectorBounds, setConnectorBounds] = useState<{
    height: number
    left: number
    top: number
    width: number
  } | null>(null)
  const utilityActions: Array<{
    action: EmptyWorkspaceAction
    title: string
    description: string
    onClick: () => void
  }> = [
    { action: 'search', title: copy.search, description: copy.emptyWorkspaceSearchDescription, onClick: onOpenSearch },
    { action: 'share', title: copy.sharePage, description: copy.emptyWorkspaceShareDescription, onClick: onOpenShare },
    { action: 'focus', title: copy.emptyWorkspaceFocus, description: copy.emptyWorkspaceFocusDescription, onClick: onOpenAppMode },
    { action: 'plugins', title: copy.plugins, description: copy.emptyWorkspacePluginsDescription, onClick: onOpenPlugins },
  ]

  useLayoutEffect(() => {
    const home = homeRef.current
    const originBrace = originBraceRef.current
    const targetBrace = targetBraceRef.current
    if (!home || !originBrace || !targetBrace) return

    const updateConnectorBounds = () => {
      const homeRect = home.getBoundingClientRect()
      const originRect = originBrace.getBoundingClientRect()
      const targetRect = targetBrace.getBoundingClientRect()
      if (homeRect.width === 0 || originRect.width === 0 || targetRect.width === 0) {
        setConnectorBounds(null)
        return
      }
      const left = originRect.right - homeRect.left + 5
      const top = originRect.top + originRect.height / 2 - homeRect.top
      const width = targetRect.left - homeRect.left - left
      const height = targetRect.top + targetRect.height / 2 - homeRect.top - top
      if (width <= 0 || height <= 0) {
        setConnectorBounds(null)
        return
      }
      setConnectorBounds(previous => {
        const next = { height, left, top, width }
        return previous
          && previous.height === next.height
          && previous.left === next.left
          && previous.top === next.top
          && previous.width === next.width
          ? previous
          : next
      })
    }

    updateConnectorBounds()
    const observer = new ResizeObserver(updateConnectorBounds)
    observer.observe(home)
    observer.observe(originBrace)
    observer.observe(targetBrace)
    return () => observer.disconnect()
  }, [])

  return (
    <div ref={homeRef} className="code-empty-home">
      <span ref={originBraceRef} className="code-empty-home-brace" data-testid="code-empty-home-brace" aria-hidden="true">
        <svg viewBox="0 0 12 28">
          <path d="M2 1.25h1.2c2.25 0 3.2 1.55 3.2 4.1v4.05c0 2.5 1.05 4.05 3.6 4.6-2.55.55-3.6 2.1-3.6 4.6v4.05c0 2.55-.95 4.1-3.2 4.1H2" />
        </svg>
      </span>
      {connectorBounds && (
        <svg
          className="code-empty-home-connector"
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          style={connectorBounds}
          aria-hidden="true"
        >
          <defs>
            <linearGradient id="code-empty-home-connector-weight" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="white" stopOpacity="0" />
              <stop offset="0.56" stopColor="white" stopOpacity="0.65" />
              <stop offset="0.78" stopColor="white" stopOpacity="1" />
              <stop offset="1" stopColor="white" stopOpacity="1" />
            </linearGradient>
            <mask id="code-empty-home-connector-mask" maskUnits="objectBoundingBox">
              <rect width="100%" height="100%" fill="url(#code-empty-home-connector-weight)" />
            </mask>
          </defs>
          <path className="code-empty-home-connector-base" d="M0 0C200 0-100 100 100 100" />
          <path
            className="code-empty-home-connector-growth"
            d="M0 0C200 0-100 100 100 100"
            mask="url(#code-empty-home-connector-mask)"
          />
        </svg>
      )}
      <header className="code-empty-home-header">
        <h2>{copy.emptyWorkspaceWelcome}</h2>
        <p>{copy.emptyWorkspaceWelcomeDescription}</p>
      </header>
      <div className="code-empty-home-action-map">
        <span ref={targetBraceRef} className="code-empty-home-target-brace" data-testid="code-empty-home-target-brace" aria-hidden="true">
          <svg viewBox="0 0 30 100" preserveAspectRatio="none">
            <path d="M28 1h-2.4C16 1 14 8.5 14 20v14c0 8.6-4 13.9-14 16 10 2.1 14 7.4 14 16v14c0 11.5 2 19 11.6 19H28" />
          </svg>
        </span>
        <div className="code-empty-home-actions">
          <div className="code-empty-home-primary">
            <button
              type="button"
              className="code-empty-home-card primary history"
              data-testid="code-empty-home-history"
              onClick={onOpenHistory}
            >
              <span className="code-empty-home-card-icon"><EmptyWorkspaceActionGlyph action="history" /></span>
              <strong>{copy.emptyWorkspaceContinue}</strong>
              <span>{copy.emptyWorkspaceContinueDescription}</span>
            </button>
            <button
              type="button"
              className="code-empty-home-card primary"
              data-testid="code-empty-home-new-agent"
              onClick={() => onNewAgent(agentCreationWorkspace)}
            >
              <span className="code-empty-home-card-icon"><EmptyWorkspaceActionGlyph action="new-agent" /></span>
              <strong>{copy.newAgent}</strong>
              <span>{copy.emptyWorkspaceNewAgentDescription}</span>
            </button>
          </div>
          <div className="code-empty-home-utilities">
            {utilityActions.map(item => (
              <button
                key={item.action}
                type="button"
                className="code-empty-home-card utility"
                data-testid={`code-empty-home-${item.action}`}
                onClick={item.onClick}
              >
                <span className="code-empty-home-card-icon"><EmptyWorkspaceActionGlyph action={item.action} /></span>
                <span className="code-empty-home-card-copy">
                  <strong>{item.title}</strong>
                  <span>{item.description}</span>
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

export function CodeMainArea({
  inert,
  readOnly,
  activeView,
  activeBrowserResource,
  browserController,
  onBackFromBrowser,
  onOpenBrowserResource,
  activeComputerResource,
  computerController,
  onBackFromComputer,
  language,
  showFileEditor,
  openWorkspaceFile,
  openWorkspaceFiles,
  retainedWorkspaceFileModels,
  openAgentsCount,
  openAgents,
  activeTerminalId,
  resourceAgentId,
  permissionSwitchingAgentId,
  agentSwitchingKind,
  terminalFocusRequest,
  agentCreationWorkspace,
  displayedProjects,
  searchQuery,
  searchHasQuery,
  searchLoading,
  searchScope,
  searchCounts,
  onSearchScopeChange,
  globalFileSearchLoading,
  visibleSearchTargetCount,
  selectedSearchAgentId,
  selectedSearchSessionHandle,
  selectedSearchFileKey,
  globalFileSearchMatches,
  globalFileSearchFailedProjectCount,
  globalFileSearchIncomplete,
  globalFileSearchQueryTooLong,
  globalFileOpenError,
  globalFileOpeningKey,
  searchInputRef,
  archivedRuns,
  archivedAgents,
  historyAgentSessions,
  openHistorySessionKeys,
  historyAgentSessionsLoading,
  historyAgentSessionsError,
  providerSessionTotal,
  historySessionRevealRequest,
  canLoadMoreHistoryAgentSessions,
  now,
  composerProps,
  acpComposerProps,
  onNewAgent,
  onOpenHistory,
  onOpenPlugins,
  pluginsNavigationState,
  onPluginsNavigationStateChange,
  onOpenAgentHomeConfiguration,
  onOpenSearch,
  onOpenShare,
  onOpenAppMode,
  onOpenTerminal,
  onOpenTerminalPath,
  onResolveTerminalPath,
  onSearchTerminalWord,
  onTerminalFollowOutputChange,
  onAgentReadLatest,
  onRuntimeModeChange,
  onForkAgent,
  onReviewAndCommit,
  onSessionOutput,
  onOpenSearchAgent,
  onOpenSearchSession,
  onOpenSearchFile,
  onRetryGlobalFileSearch,
  onSearchQueryChange,
  onSearchKeyDown,
  onCloseSearch,
  onBackToProjects,
  onLoadMoreHistoryAgentSessions,
  onSearchHistoryAgentSessions,
  onResumeHistorySession,
  onContinueArchivedRun,
  onOpenArchivedAgent,
  onRestoreArchivedAgent,
  onChangeWorkspaceFileDraft,
  onUpdateOpenWorkspaceFile,
  onResolveWorkspaceFile,
  onSelectOpenWorkspaceFile,
  onOpenWorkspaceFilePath,
  onCopyReadOnlyShareLink,
  onOpenUrlInFarming,
  canNavigateWorkspaceBack,
  canNavigateWorkspaceForward,
  onNavigateWorkspaceHistory,
  onCloseOpenWorkspaceFile,
  onCloseOpenWorkspaceFiles,
  onReorderOpenWorkspaceFile,
  onRevealWorkspaceFileInExplorer,
  onFocusWorkspaceFilesSearch,
  onRecordWorkspaceNavigationCursor,
  onBackToAgentFromFile,
  copy,
}: CodeMainAreaProps) {
  const [terminalComposerCollapsed, setTerminalComposerCollapsed] = useState(readTerminalComposerCollapsed)
  const [chatComposerCollapseRequested, setChatComposerCollapseRequested] = useState(false)
  const [runtimeSwitchExpandedAgentId, setRuntimeSwitchExpandedAgentId] = useState<string | null>(null)
  const [dismissedBrowserPreviewKeys, setDismissedBrowserPreviewKeys] = useState<Set<string>>(() => new Set())
  const [activePlanPreview, setActivePlanPreview] = useState<{
    agentId: string
    plan: AgentTranscriptProcessItem
  } | null>(null)
  const [expandedAgentActivity, setExpandedAgentActivity] = useState<string | null>(null)
  const [resourceAgentPanelOpen, setResourceAgentPanelOpen] = useState(readResourceAgentPanelOpen)
  const [resourceAgentWidth, setResourceAgentWidth] = useState(DEFAULT_RESOURCE_AGENT_WIDTH)
  const [resourceAgentWidthMax, setResourceAgentWidthMax] = useState(MAX_RESOURCE_AGENT_WIDTH)
  const mainAreaRef = useRef<HTMLElement | null>(null)
  const resourceAgentResizeGestureRef = useRef<{
    pointerId: number
    target: HTMLDivElement
  } | null>(null)
  const previousActiveRuntimeRef = useRef<{ agentId: string | null; kind: 'acp' | 'terminal' | null }>({
    agentId: null,
    kind: null,
  })
  const [composerCollapseSupported, setComposerCollapseSupported] = useState(supportsComposerCollapse)
  const [fileEditorPane, setFileEditorPane] = useState<FileEditorPaneComponent | null>(() => loadedFileEditorPane)
  const [fileEditorPaneLoadError, setFileEditorPaneLoadError] = useState<unknown>(null)
  const ReadyFileEditorPane = fileEditorPane ?? loadedFileEditorPane
  const fileEditorRequested = showFileEditor && openWorkspaceFile !== null

  useEffect(() => {
    if (!fileEditorRequested || ReadyFileEditorPane) return undefined
    let active = true
    void loadFileEditorPane().then(module => {
      if (active) setFileEditorPane(() => module.default)
    }).catch(error => {
      if (active) setFileEditorPaneLoadError(error)
    })
    return () => {
      active = false
    }
  }, [ReadyFileEditorPane, fileEditorRequested])

  const activeAgent = activeTerminalId
    ? openAgents.find(agent => agent.id === activeTerminalId) || null
    : null
  // Latest activeAgent read via ref so the layout effect below can inspect the
  // whole object without depending on it — it only reruns on activeAgent?.id.
  const activeAgentRef = useRef(activeAgent)
  activeAgentRef.current = activeAgent
  const browserWorkspaceVisible = activeView === 'projects' && activeBrowserResource !== null
  const computerWorkspaceVisible = activeView === 'projects' && activeComputerResource !== null
  const resourceWorkspaceVisible = browserWorkspaceVisible
    || computerWorkspaceVisible
    || (activeView === 'projects' && showFileEditor && openWorkspaceFile !== null)
  const agentWorkspaceVisible = activeView === 'projects'
    && !browserWorkspaceVisible
    && !computerWorkspaceVisible
    && !(showFileEditor && openWorkspaceFile)
  const resourceAgentPanelVisible = resourceWorkspaceVisible
    && resourceAgentPanelOpen
    && resourceAgentId !== null
    && activeTerminalId === resourceAgentId
  const agentSurfaceVisible = agentWorkspaceVisible || resourceAgentPanelVisible
  const acpComposerActive = isAcpRuntime(activeAgent)
  const activeBrowserPreviews = activeAgent
    ? (browserController.byAgentId.get(activeAgent.id) ?? [])
      .filter(resource => resource.status === 'running' || resource.status === 'reconnecting')
      .filter(resource => resource.id !== activeBrowserResource?.id)
      .filter(resource => !dismissedBrowserPreviewKeys.has(`${resource.id}:${resource.generation}`))
      .sort((left, right) => left.updatedAt - right.updatedAt)
    : []
  const visibleActivePlan = activePlanPreview && activePlanPreview.agentId === activeAgent?.id
    ? activePlanPreview.plan
    : null
  const expandedBrowserResourceId = expandedAgentActivity?.startsWith('browser:')
    ? expandedAgentActivity.slice('browser:'.length)
    : null
  const expandedBrowserAvailable = expandedBrowserResourceId === null
    || activeBrowserPreviews.some(resource => resource.id === expandedBrowserResourceId)
  const browserOwnerAgent = activeBrowserResource
    ? openAgents.find(agent => agent.id === activeBrowserResource.ownerAgentId) || null
    : null
  const browserOwnerName = browserOwnerAgent
    ? agentTitle(browserOwnerAgent)
    : activeBrowserResource?.ownerAgentId || ''
  const terminalComposerActive = activeAgent?.runtimeBinding.kind === 'terminal'
  const composerCollapseRequested = terminalComposerActive
    ? (runtimeSwitchExpandedAgentId === activeAgent?.id ? false : terminalComposerCollapsed)
    : chatComposerCollapseRequested
  const canCollapseComposer = composerCollapseSupported
    && activeView === 'projects'
    && (!showFileEditor || resourceAgentPanelVisible)
    && openAgentsCount > 0
  const composerCollapsed = canCollapseComposer && composerCollapseRequested

  const toggleResourceAgentPanel = useCallback(() => {
    if (!resourceAgentId) return
    const nextOpen = !resourceAgentPanelOpen
    writeResourceAgentPanelOpen(nextOpen)
    if (nextOpen && activeTerminalId !== resourceAgentId) {
      onOpenTerminal(resourceAgentId, { focusTerminal: false })
    }
    setResourceAgentPanelOpen(nextOpen)
  }, [activeTerminalId, onOpenTerminal, resourceAgentId, resourceAgentPanelOpen])

  const updateResourceAgentWidth = useCallback((clientX: number) => {
    const mainRect = mainAreaRef.current?.getBoundingClientRect()
    if (!mainRect) return
    const maxWidth = maxResourceAgentWidth(mainRect.width)
    const rawWidth = mainRect.right - clientX
    setResourceAgentWidthMax(maxWidth)
    setResourceAgentWidth(clampResourceAgentWidth(rawWidth, mainRect.width))
  }, [])

  const handleResourceAgentResizeKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    let nextWidth: number | null = null
    if (event.key === 'ArrowLeft') nextWidth = resourceAgentWidth + 16
    else if (event.key === 'ArrowRight') nextWidth = resourceAgentWidth - 16
    else if (event.key === 'Home') nextWidth = MIN_RESOURCE_AGENT_WIDTH
    else if (event.key === 'End') nextWidth = resourceAgentWidthMax
    if (nextWidth === null) return
    event.preventDefault()
    setResourceAgentWidth(Math.max(MIN_RESOURCE_AGENT_WIDTH, Math.min(resourceAgentWidthMax, nextWidth)))
  }, [resourceAgentWidth, resourceAgentWidthMax])

  const beginResourceAgentResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !event.isPrimary || resourceAgentResizeGestureRef.current) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    resourceAgentResizeGestureRef.current = {
      pointerId: event.pointerId,
      target: event.currentTarget,
    }
    document.body.classList.add('code-resizing-resource-agent')
    updateResourceAgentWidth(event.clientX)
  }, [updateResourceAgentWidth])

  const finishResourceAgentResize = useCallback((
    target: HTMLDivElement,
    pointerId: number,
    clientX?: number,
  ) => {
    const gesture = resourceAgentResizeGestureRef.current
    if (!gesture || gesture.pointerId !== pointerId) return
    if (clientX !== undefined) updateResourceAgentWidth(clientX)
    resourceAgentResizeGestureRef.current = null
    document.body.classList.remove('code-resizing-resource-agent')
    if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId)
  }, [updateResourceAgentWidth])

  useEffect(() => () => {
    const gesture = resourceAgentResizeGestureRef.current
    resourceAgentResizeGestureRef.current = null
    document.body.classList.remove('code-resizing-resource-agent')
    if (gesture?.target.hasPointerCapture(gesture.pointerId)) {
      gesture.target.releasePointerCapture(gesture.pointerId)
    }
  }, [])

  useLayoutEffect(() => {
    if (!resourceAgentPanelVisible || typeof ResizeObserver === 'undefined') return undefined
    const element = mainAreaRef.current
    if (!element) return undefined
    const reconcileWidth = () => {
      const mainWidth = element.getBoundingClientRect().width
      const maxWidth = maxResourceAgentWidth(mainWidth)
      setResourceAgentWidthMax(maxWidth)
      setResourceAgentWidth(current => clampResourceAgentWidth(current, mainWidth))
    }
    reconcileWidth()
    const observer = new ResizeObserver(reconcileWidth)
    observer.observe(element)
    return () => observer.disconnect()
  }, [resourceAgentPanelVisible])

  useEffect(() => {
    if (!resourceAgentPanelOpen || activeView !== 'projects' || !resourceAgentId) return
    if (activeTerminalId !== resourceAgentId) {
      onOpenTerminal(resourceAgentId, { focusTerminal: false })
    }
  }, [activeTerminalId, activeView, onOpenTerminal, resourceAgentId, resourceAgentPanelOpen])

  useLayoutEffect(() => {
    const previous = previousActiveRuntimeRef.current
    const currentKind = acpComposerActive ? 'acp' : terminalComposerActive ? 'terminal' : null
    const activeId = activeAgent?.id ?? null
    if (
      previous.kind === 'acp'
      && currentKind === 'terminal'
      && activeId
      && replacesAgent(activeAgentRef.current, previous.agentId)
    ) {
      // Runtime switching replaces the Agent id. Preserve the visible Chat
      // composer for that replacement without changing the user's normal
      // preference for newly opened Terminal sessions.
      setRuntimeSwitchExpandedAgentId(activeId)
    }
    previousActiveRuntimeRef.current = { agentId: activeId, kind: currentKind }
  }, [acpComposerActive, activeAgent?.id, terminalComposerActive])

  useEffect(() => {
    setExpandedAgentActivity(null)
  }, [activeAgent?.id])

  useEffect(() => {
    if (expandedAgentActivity === 'plan' && !visibleActivePlan) {
      setExpandedAgentActivity(null)
      return
    }
    if (expandedBrowserResourceId && !expandedBrowserAvailable) {
      setExpandedAgentActivity(null)
    }
  }, [expandedAgentActivity, expandedBrowserAvailable, expandedBrowserResourceId, visibleActivePlan])

  const publishActivePlan = useCallback((agentId: string, plan: AgentTranscriptProcessItem | undefined) => {
    setActivePlanPreview(current => {
      if (!plan) return current?.agentId === agentId ? null : current
      return current?.agentId === agentId
        && current.plan.detail === plan.detail
        && current.plan.completedSteps === plan.completedSteps
        && current.plan.totalSteps === plan.totalSteps
        && current.plan.currentStep === plan.currentStep
        ? current
        : { agentId, plan }
    })
  }, [])

  useEffect(() => {
    const mediaQuery = window.matchMedia('(hover: hover) and (pointer: fine)')
    const updateCollapseSupport = () => setComposerCollapseSupported(supportsComposerCollapse())
    updateCollapseSupport()
    mediaQuery.addEventListener('change', updateCollapseSupport)
    window.addEventListener('resize', updateCollapseSupport)
    return () => {
      mediaQuery.removeEventListener('change', updateCollapseSupport)
      window.removeEventListener('resize', updateCollapseSupport)
    }
  }, [])

  useEffect(() => {
    if (!canCollapseComposer && chatComposerCollapseRequested) {
      setChatComposerCollapseRequested(false)
    }
  }, [canCollapseComposer, chatComposerCollapseRequested])

  // Detach the refreshCapability methods so calling them does not pull the whole
  // controller objects into the deps (they would rerun and remount the viewers).
  const refreshBrowserCapability = browserController.refreshCapability
  const refreshComputerCapability = computerController.refreshCapability
  const refreshPluginCapabilities = useCallback(() => {
    refreshBrowserCapability()
    refreshComputerCapability()
  }, [refreshBrowserCapability, refreshComputerCapability])

  const updateComposerCollapsed = useCallback((collapsed: boolean) => {
    if (terminalComposerActive) {
      setRuntimeSwitchExpandedAgentId(null)
      setTerminalComposerCollapsed(collapsed)
      writeTerminalComposerCollapsed(collapsed)
      return
    }
    setChatComposerCollapseRequested(collapsed)
  }, [terminalComposerActive])

  const dismissComposerKeyboardOnMainPress = useCallback((event: ReactSyntheticEvent<HTMLElement>) => {
    if (!isTouchInputViewport()) return
    const target = event.target
    if (target instanceof Element && target.closest('.code-composer')) return
    const activeElement = document.activeElement
    if (!(activeElement instanceof HTMLElement)) return
    if (!activeElement.closest('.code-composer')) return
    if (
      activeElement instanceof HTMLTextAreaElement
      || activeElement.isContentEditable
      || activeElement.getAttribute('role') === 'textbox'
    ) {
      activeElement.blur()
    }
  }, [])

  if (fileEditorPaneLoadError) throw fileEditorPaneLoadError

  return (
    <main
      ref={mainAreaRef}
      className={`code-main ${resourceAgentPanelVisible ? 'resource-agent-side-open' : ''}`.trim()}
      data-testid="code-main"
      style={resourceAgentPanelVisible ? {
        '--code-resource-agent-width': `${resourceAgentWidth}px`,
      } as CSSProperties : undefined}
      inert={inert ? true : undefined}
      onPointerDownCapture={dismissComposerKeyboardOnMainPress}
      onTouchStartCapture={dismissComposerKeyboardOnMainPress}
    >
      {activeView !== 'projects' ? (
        <section
          className={`code-side-view-panel ${activeView === 'search' ? 'code-search-view' : ''} ${activeView === 'history' ? 'code-history-view' : ''} ${activeView === 'plugins' ? 'code-plugins-view' : ''}`}
          data-testid="code-side-view-panel"
        >
          {activeView === 'search' ? (
            <SearchPanel
              query={searchQuery}
              displayedProjects={displayedProjects}
              hasQuery={searchHasQuery}
              loading={searchLoading}
              scope={searchScope}
              counts={searchCounts}
              onScopeChange={onSearchScopeChange}
              fileSearchLoading={globalFileSearchLoading}
              resultCount={visibleSearchTargetCount}
              selectedAgentId={selectedSearchAgentId}
              selectedSessionHandle={selectedSearchSessionHandle}
              selectedFileKey={selectedSearchFileKey}
              fileMatches={globalFileSearchMatches}
              fileSearchFailedProjectCount={globalFileSearchFailedProjectCount}
              fileSearchIncomplete={globalFileSearchIncomplete}
              queryTooLong={globalFileSearchQueryTooLong}
              fileOpenError={globalFileOpenError}
              openingFileKey={globalFileOpeningKey}
              inputRef={searchInputRef}
              onQueryChange={onSearchQueryChange}
              onKeyDown={onSearchKeyDown}
              onClearSearch={onCloseSearch}
              onBack={onCloseSearch}
              onOpenAgent={onOpenSearchAgent}
              onOpenSession={onOpenSearchSession}
              onOpenFile={onOpenSearchFile}
              onRetryFileSearch={onRetryGlobalFileSearch}
              copy={copy}
            />
          ) : activeView === 'history' ? (
            <HistoryPanel
              archivedRuns={archivedRuns}
              archivedAgents={archivedAgents}
              agentSessions={historyAgentSessions}
              openSessionKeys={openHistorySessionKeys}
              loading={historyAgentSessionsLoading}
              error={historyAgentSessionsError}
              providerSessionTotal={providerSessionTotal}
              revealSession={historySessionRevealRequest}
              now={now}
              onResumeSession={onResumeHistorySession}
              onContinueRun={onContinueArchivedRun}
              onOpenArchivedAgent={onOpenArchivedAgent}
              onRestoreArchivedAgent={onRestoreArchivedAgent}
              searchAgentSessions={onSearchHistoryAgentSessions}
              canLoadMoreAgentSessions={canLoadMoreHistoryAgentSessions}
              onLoadMoreAgentSessions={onLoadMoreHistoryAgentSessions}
              onBack={onBackToProjects}
              copy={copy}
            />
          ) : activeView === 'plugins' ? (
            <PluginsPanel
              capability={browserController.capability}
              loading={browserController.loading}
              capabilityError={browserController.capabilityError}
              computerCapability={computerController.capability}
              computerLoading={computerController.loading}
              computerCapabilityError={computerController.capabilityError}
              onPrepareComputer={computerController.prepare}
              language={language}
              navigationState={pluginsNavigationState}
              onNavigationStateChange={onPluginsNavigationStateChange}
              canNavigateBack={canNavigateWorkspaceBack}
              onNavigateHistory={onNavigateWorkspaceHistory}
              onBack={onBackToProjects}
              onOpenAgentHomeConfiguration={onOpenAgentHomeConfiguration}
              onRefreshCapability={refreshPluginCapabilities}
            />
          ) : (
            <h2>{viewTitle(copy, activeView)}</h2>
          )}
        </section>
      ) : browserWorkspaceVisible ? (
        <BrowserViewer
          resource={activeBrowserResource}
          controller={browserController}
          language={language}
          ownerName={browserOwnerName}
          onResource={browserController.mergeResource}
          onOpenResource={onOpenBrowserResource}
          onBackToAgent={onBackFromBrowser}
          agentSidePanelOpen={resourceAgentPanelOpen}
          onToggleAgentSidePanel={resourceAgentId ? toggleResourceAgentPanel : undefined}
        />
      ) : computerWorkspaceVisible ? (
        <ComputerViewer
          resource={activeComputerResource}
          controller={computerController}
          language={language}
          onBackToAgent={onBackFromComputer}
          agentSidePanelOpen={resourceAgentPanelOpen}
          onToggleAgentSidePanel={resourceAgentId ? toggleResourceAgentPanel : undefined}
        />
      ) : showFileEditor && openWorkspaceFile ? (
        ReadyFileEditorPane ? (
          <ReadyFileEditorPane
            openFile={openWorkspaceFile}
            globalReadOnly={readOnly}
            openFiles={openWorkspaceFiles}
            retainedFiles={retainedWorkspaceFileModels}
            onChangeDraft={onChangeWorkspaceFileDraft}
            onUpdateOpenFile={onUpdateOpenWorkspaceFile}
            onResolveFile={onResolveWorkspaceFile}
            onSelectOpenFile={onSelectOpenWorkspaceFile}
            onOpenFilePath={onOpenWorkspaceFilePath}
            onCopyReadOnlyShareLink={onCopyReadOnlyShareLink}
            canNavigateBack={canNavigateWorkspaceBack}
            canNavigateForward={canNavigateWorkspaceForward}
            onNavigateHistory={onNavigateWorkspaceHistory}
            onCloseOpenFile={onCloseOpenWorkspaceFile}
            onCloseOpenFiles={onCloseOpenWorkspaceFiles}
            onReorderOpenFile={onReorderOpenWorkspaceFile}
            onRevealInExplorer={onRevealWorkspaceFileInExplorer}
            onFocusFilesSearch={onFocusWorkspaceFilesSearch}
            onRecordNavigationCursor={onRecordWorkspaceNavigationCursor}
            onBackToAgent={onBackToAgentFromFile}
            agentSidePanelOpen={resourceAgentPanelOpen}
            onToggleAgentSidePanel={resourceAgentId ? toggleResourceAgentPanel : undefined}
            copy={copy}
          />
        ) : (
          <FileEditorFallback openFile={openWorkspaceFile} onChangeDraft={onChangeWorkspaceFileDraft} readOnly={readOnly} copy={copy} />
        )
      ) : null}

      {resourceAgentPanelVisible ? (
        <div
          className="code-resource-agent-resizer"
          data-testid="code-resource-agent-resizer"
          role="separator"
          aria-label={copy.resizeAgentSidePanel}
          aria-orientation="vertical"
          aria-valuemin={MIN_RESOURCE_AGENT_WIDTH}
          aria-valuemax={Math.round(resourceAgentWidthMax)}
          aria-valuenow={Math.round(resourceAgentWidth)}
          tabIndex={0}
          onPointerDown={beginResourceAgentResize}
          onPointerMove={event => {
            const gesture = resourceAgentResizeGestureRef.current
            if (!gesture || gesture.pointerId !== event.pointerId) return
            if (event.pointerType === 'mouse' && event.buttons === 0) {
              finishResourceAgentResize(event.currentTarget, event.pointerId, event.clientX)
              return
            }
            event.preventDefault()
            updateResourceAgentWidth(event.clientX)
          }}
          onPointerUp={event => {
            finishResourceAgentResize(event.currentTarget, event.pointerId, event.clientX)
          }}
          onPointerCancel={event => {
            finishResourceAgentResize(event.currentTarget, event.pointerId)
          }}
          onLostPointerCapture={event => {
            finishResourceAgentResize(event.currentTarget, event.pointerId)
          }}
          onKeyDown={handleResourceAgentResizeKeyDown}
        />
      ) : null}

      <div
        className="code-terminal-grid panes-1"
        data-testid="code-terminal-grid"
        hidden={!agentSurfaceVisible}
      >
        {openAgentsCount === 0 ? (
          <div className="code-empty-workspace code-empty-home-state" data-testid="code-empty-workspace">
            <EmptyWorkspaceGuide
              agentCreationWorkspace={agentCreationWorkspace}
              onNewAgent={onNewAgent}
              onOpenHistory={onOpenHistory}
              onOpenPlugins={onOpenPlugins}
              onOpenSearch={onOpenSearch}
              onOpenShare={onOpenShare}
              onOpenAppMode={onOpenAppMode}
              copy={copy}
            />
            <div className="code-empty-workspace-compact">
              <h2>{copy.startOrSelectAgent}</h2>
              <p>{copy.startOrSelectAgentDescription}</p>
              <div className="code-empty-workspace-compact-actions">
                <button
                  type="button"
                  className="code-empty-home-card compact-primary"
                  data-testid="code-empty-compact-history"
                  onClick={onOpenHistory}
                >
                  <span className="code-empty-home-card-icon"><HistoryGlyph /></span>
                  <span className="code-empty-home-card-copy">
                    <strong>{copy.emptyWorkspaceContinue}</strong>
                    <span>{copy.history}</span>
                  </span>
                </button>
                <button
                  type="button"
                  className="code-empty-home-card compact-primary"
                  data-testid="code-empty-compact-new-agent"
                  onClick={() => onNewAgent(agentCreationWorkspace)}
                >
                  <span className="code-empty-home-card-icon"><NewAgentGlyph /></span>
                  <span className="code-empty-home-card-copy">
                    <strong>{copy.newAgent}</strong>
                    <span>{copy.emptyWorkspaceNewAgentDescription}</span>
                  </span>
                </button>
                <button
                  type="button"
                  className="code-empty-home-card compact-primary"
                  data-testid="code-empty-compact-plugins"
                  onClick={onOpenPlugins}
                >
                  <span className="code-empty-home-card-icon"><PuzzleGlyph /></span>
                  <span className="code-empty-home-card-copy">
                    <strong>{copy.plugins}</strong>
                    <span>{copy.emptyWorkspacePluginsDescription}</span>
                  </span>
                </button>
              </div>
            </div>
          </div>
        ) : (
          openAgents.map(agent => (
            <AgentWorkPane
              key={agent.id}
              agent={agent}
              mounted={(agentSurfaceVisible || resourceWorkspaceVisible) && agent.id === activeTerminalId}
              active={agentSurfaceVisible && agent.id === activeTerminalId}
              runtimeSwitchVisible={!resourceAgentPanelVisible}
              viewportLayoutKey={`${resourceAgentPanelVisible ? 'agent-side' : 'agent-full'}:${composerCollapsed ? 'composer-collapsed' : 'composer-expanded'}`}
              switching={agent.id === permissionSwitchingAgentId}
              switchingKind={agent.id === permissionSwitchingAgentId ? agentSwitchingKind : null}
              onActivate={onOpenTerminal}
              onOpenPath={onOpenTerminalPath}
              onResolvePath={onResolveTerminalPath}
              onSearchTerminalWord={onSearchTerminalWord}
              onOpenWorkspaceFilePath={onOpenWorkspaceFilePath}
              onCopyReadOnlyShareLink={onCopyReadOnlyShareLink}
              onOpenUrlInFarming={onOpenUrlInFarming}
              onFollowOutputChange={onTerminalFollowOutputChange}
              onReadLatest={onAgentReadLatest}
              onRuntimeModeChange={onRuntimeModeChange}
              onForkAgent={onForkAgent}
              onReviewAndCommit={onReviewAndCommit}
              onActivePlanChange={publishActivePlan}
              onSessionOutput={onSessionOutput}
              focusSignal={terminalFocusRequest?.agentId === agent.id ? terminalFocusRequest.nonce : 0}
              copy={copy}
            />
          ))
        )}
      </div>

      {agentSurfaceVisible && (visibleActivePlan || activeBrowserPreviews.length > 0) ? (
        <section
          className="code-agent-activity-dock"
          data-testid="code-agent-activity-dock"
          aria-label="Agent activity"
          onKeyDown={event => {
            if (event.key !== 'Escape' || expandedAgentActivity === null) return
            event.stopPropagation()
            setExpandedAgentActivity(null)
          }}
        >
          {visibleActivePlan ? (
            <AgentPlanActivityPreview
              plan={visibleActivePlan}
              expanded={expandedAgentActivity === 'plan'}
              onToggle={() => setExpandedAgentActivity(current => current === 'plan' ? null : 'plan')}
            />
          ) : null}
          {activeBrowserPreviews.length > 0 ? (
            <BrowserActivityPreview
              resources={activeBrowserPreviews}
              language={language}
              expandedResourceId={expandedBrowserResourceId}
              onToggle={resource => setExpandedAgentActivity(current => {
                const key = `browser:${resource.id}`
                return current === key ? null : key
              })}
              onOpen={onOpenBrowserResource}
              onDismiss={resource => setDismissedBrowserPreviewKeys(current => {
                const next = new Set(current)
                next.add(`${resource.id}:${resource.generation}`)
                return next
              })}
            />
          ) : null}
        </section>
      ) : null}

      {agentSurfaceVisible ? (
        composerCollapsed ? (
          <div className="code-composer-restore-bar" data-testid="code-composer-restore-bar">
            <button
              type="button"
              className="code-composer-restore"
              data-testid="code-composer-restore"
              aria-label={copy.restoreComposer}
              title={copy.restoreComposer}
              onClick={() => updateComposerCollapsed(false)}
            >
              <ChevronUpGlyph />
            </button>
          </div>
        ) : (
          <div className={`code-composer-shell ${canCollapseComposer ? 'collapsible' : ''}`}>
            {canCollapseComposer ? (
              <div className="code-composer-collapse-zone" aria-hidden="false">
                <button
                  type="button"
                  className="code-composer-collapse"
                  data-testid="code-composer-collapse"
                  aria-label={copy.collapseComposer}
                  title={copy.collapseComposer}
                  onClick={() => updateComposerCollapsed(true)}
                >
                  <ChevronDownGlyph />
                </button>
              </div>
            ) : null}
            {acpComposerActive ? (
              <AcpComposer {...acpComposerProps} copy={copy} />
            ) : (
              <CodeComposer {...composerProps} copy={copy} />
            )}
          </div>
        )
      ) : null}
    </main>
  )
}
