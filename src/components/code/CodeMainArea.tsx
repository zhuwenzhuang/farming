import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ComponentProps, type KeyboardEvent as ReactKeyboardEvent, type RefObject, type SyntheticEvent as ReactSyntheticEvent } from 'react'
import type { Agent, TaskHistoryEntry } from '@/types/agent'
import { isAcpRuntime } from '@/lib/agent-runtime'
import type { TerminalPathOpenTarget } from '@/lib/terminal-session-pool'
import type { OpenWorkspaceFile, WorkspaceOpenFileTarget } from '@/lib/workspace-open-files'
import type { WorkspaceNavigationFileInput } from '@/lib/workspace-navigation-history'
import { isCompactViewport, isTouchInputViewport } from '@/lib/responsive-mode'
import { isWorkspaceMarkdownFile } from '@/lib/workspace-editor-model'
import { AgentWorkPane } from './AgentWorkPane'
import { CodeComposer } from './CodeComposer'
import { AcpComposer } from './acp/AcpComposer'
import { HistoryPanel } from './HistoryPanel'
import { SearchPanel } from './SearchPanel'
import {
  ChevronDownGlyph,
  ChevronLeftGlyph,
  ChevronUpGlyph,
  FocusModeGlyph,
  HistoryGlyph,
  NewAgentGlyph,
  QrGlyph,
  SearchGlyph,
} from '../IconGlyphs'
import type { CodeCopy } from './copy'
import type { AgentSessionHistoryItem, ProjectGroup, WorkspaceFileOpenTarget, WorkspaceView } from './types'

type ComposerProps = Omit<ComponentProps<typeof CodeComposer>, 'copy'>
type AcpComposerProps = Omit<ComponentProps<typeof AcpComposer>, 'copy'>
type TerminalFollowState = {
  following: boolean
  hasUnreadOutput: boolean
}

const TERMINAL_COMPOSER_COLLAPSED_STORAGE_KEY = 'farming.code.terminalComposerCollapsed.v1'

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
    fileEditorPaneLoadPromise = Promise.all([
      import('../files/FileEditorPane'),
      import('@/lib/workspace-editor-monaco').then(editorMonaco => {
        void editorMonaco.preloadWorkspaceEditorMonaco()
      }),
    ]).then(([module]) => {
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

function preloadFileEditorPane(onLoad: (component: FileEditorPaneComponent) => void) {
  void loadFileEditorPaneModule().then(module => {
    onLoad(module.default)
  }).catch(() => {
    // Opening a file owns the existing bounded reload path for chunk failures.
  })
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
  copy,
}: {
  openFile: OpenWorkspaceFile
  onChangeDraft: (draft: string) => void
  copy: CodeCopy
}) {
  const segments = pathSegments(openFile.file.path)
  const projectLabel = workspaceLabel(openFile.workspaceRoot)
  const showBreadcrumbs = !isWorkspaceMarkdownFile(openFile.file.path)
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
        spellCheck={false}
        data-lpignore="true"
        data-1p-ignore="true"
        data-bwignore="true"
        data-form-type="other"
        aria-label={copy.editorFor(openFile.file.path)}
      />
      <footer className="code-file-editor-statusbar">
        <span className="code-file-editor-cursor-position">{copy.cursorPosition(1, 1)}</span>
      </footer>
    </section>
  )
}

interface CodeMainAreaProps {
  activeView: WorkspaceView
  showFileEditor: boolean
  openWorkspaceFile: OpenWorkspaceFile | null
  openWorkspaceFiles: OpenWorkspaceFile[]
  openAgentsCount: number
  openAgents: Agent[]
  activeTerminalId: string | null
  permissionSwitchingAgentId: string | null
  agentSwitchingKind: 'permission' | 'runtime' | null
  terminalFocusRequest: { agentId: string; nonce: number } | null
  agentCreationWorkspace?: string
  displayedProjects: ProjectGroup[]
  searchQuery: string
  searchHasQuery: boolean
  searchLoading: boolean
  visibleSearchTargetCount: number
  selectedSearchAgentId: string | null
  selectedSearchSessionHandle: string | null
  searchInputRef: RefObject<HTMLInputElement | null>
  archivedRuns: TaskHistoryEntry[]
  archivedAgents: Agent[]
  historyAgentSessions: AgentSessionHistoryItem[]
  canLoadMoreHistoryAgentSessions: boolean
  now: number
  composerProps: ComposerProps
  acpComposerProps: AcpComposerProps
  onNewAgent: (workspace?: string, command?: string) => void
  onOpenHistory: () => void
  onOpenSearch: () => void
  onOpenShare: () => void
  onOpenAppMode: () => void
  onCollapseSidebar: () => void
  onOpenTerminal: (agentId: string, options?: { focusTerminal?: boolean }) => void
  onOpenTerminalPath: (agentId: string, target: TerminalPathOpenTarget) => void
  onResolveTerminalPath: (agentId: string, target: TerminalPathOpenTarget) => Promise<TerminalPathOpenTarget | null> | TerminalPathOpenTarget | null
  onTerminalFollowOutputChange: (agentId: string, state: TerminalFollowState) => void
  onAgentReadLatest: (
    agentId: string,
    readCut?: { runtimeEpoch: string; outputSeq: number } | null,
  ) => void
  onRuntimeModeChange: (agentId: string, mode: 'terminal' | 'chat') => void
  onSessionOutput: (agentId: string, handler: (data: string, replace?: boolean, outputSeq?: number | null, runtimeEpoch?: string, stateRevision?: number | null, cols?: number, rows?: number, kind?: 'output' | 'resize' | 'clear') => void) => () => void
  onOpenSearchAgent: (agentId: string) => void
  onOpenSearchSession: (session: AgentSessionHistoryItem) => void
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
  onUpdateOpenWorkspaceFile: (nextFile: OpenWorkspaceFile) => void
  onSelectOpenWorkspaceFile: (agentId: string, filePath: string, target?: WorkspaceFileOpenTarget) => boolean
  onOpenWorkspaceFilePath: (agentId: string, filePath: string, target?: WorkspaceFileOpenTarget) => Promise<void> | void
  canNavigateWorkspaceBack: boolean
  canNavigateWorkspaceForward: boolean
  onNavigateWorkspaceHistory: (direction: -1 | 1) => boolean
  onCloseOpenWorkspaceFile: (agentId: string, filePath: string, workspaceRoot?: string) => void
  onCloseOpenWorkspaceFiles: (targets: WorkspaceOpenFileTarget[]) => void
  onRevealWorkspaceFileInExplorer: (agentId: string, filePath: string, kind: 'directory' | 'file') => void
  onFocusWorkspaceFilesSearch: (agentId: string) => void
  onRecordWorkspaceNavigationCursor: (input: WorkspaceNavigationFileInput) => void
  onBackToAgentFromFile: (agentId: string) => void
  copy: CodeCopy
}

function viewTitle(copy: CodeCopy, view: WorkspaceView) {
  if (view === 'search') return copy.search
  if (view === 'history') return copy.history
  return 'Farming'
}

type EmptyWorkspaceAction = 'history' | 'new-agent' | 'search' | 'share' | 'focus' | 'collapse'

function EmptyWorkspaceActionGlyph({ action }: { action: EmptyWorkspaceAction }) {
  if (action === 'new-agent') return <NewAgentGlyph />
  if (action === 'search') return <SearchGlyph />
  if (action === 'collapse') return <ChevronLeftGlyph />
  if (action === 'history') return <HistoryGlyph />
  if (action === 'share') return <QrGlyph />
  return <FocusModeGlyph />
}

function EmptyWorkspaceGuide({
  agentCreationWorkspace,
  onNewAgent,
  onOpenHistory,
  onOpenSearch,
  onOpenShare,
  onOpenAppMode,
  onCollapseSidebar,
  copy,
}: {
  agentCreationWorkspace?: string
  onNewAgent: (workspace?: string, command?: string) => void
  onOpenHistory: () => void
  onOpenSearch: () => void
  onOpenShare: () => void
  onOpenAppMode: () => void
  onCollapseSidebar: () => void
  copy: CodeCopy
}) {
  const utilityActions: Array<{
    action: EmptyWorkspaceAction
    title: string
    description: string
    onClick: () => void
  }> = [
    { action: 'search', title: copy.search, description: copy.emptyWorkspaceSearchDescription, onClick: onOpenSearch },
    { action: 'share', title: copy.sharePage, description: copy.emptyWorkspaceShareDescription, onClick: onOpenShare },
    { action: 'focus', title: copy.emptyWorkspaceFocus, description: copy.emptyWorkspaceFocusDescription, onClick: onOpenAppMode },
    { action: 'collapse', title: copy.collapseSidebar, description: copy.emptyWorkspaceCollapseDescription, onClick: onCollapseSidebar },
  ]

  return (
    <div className="code-empty-home">
      <span className="code-empty-home-brace" data-testid="code-empty-home-brace" aria-hidden="true">
        <svg viewBox="0 0 12 28">
          <path d="M2 1.25h1.2c2.25 0 3.2 1.55 3.2 4.1v4.05c0 2.5 1.05 4.05 3.6 4.6-2.55.55-3.6 2.1-3.6 4.6v4.05c0 2.55-.95 4.1-3.2 4.1H2" />
        </svg>
      </span>
      <svg className="code-empty-home-origin" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        <defs>
          <linearGradient id="code-empty-home-origin-weight" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="white" stopOpacity="0" />
            <stop offset="1" stopColor="white" stopOpacity="0.65" />
          </linearGradient>
          <mask id="code-empty-home-origin-mask" maskUnits="objectBoundingBox">
            <rect width="100%" height="100%" fill="url(#code-empty-home-origin-weight)" />
          </mask>
        </defs>
        <path className="code-empty-home-connector-base" d="M9 0C22 0 84 76 84 100" />
        <path
          className="code-empty-home-connector-growth"
          d="M9 0C22 0 84 76 84 100"
          mask="url(#code-empty-home-origin-mask)"
        />
      </svg>
      <svg className="code-empty-home-target-path" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        <defs>
          <linearGradient id="code-empty-home-target-weight" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="white" stopOpacity="0.65" />
            <stop offset="0.5" stopColor="white" stopOpacity="1" />
            <stop offset="1" stopColor="white" stopOpacity="1" />
          </linearGradient>
          <mask id="code-empty-home-target-mask" maskUnits="objectBoundingBox">
            <rect width="100%" height="100%" fill="url(#code-empty-home-target-weight)" />
          </mask>
        </defs>
        <path className="code-empty-home-connector-base" d="M84 0C84 24 88 43 92 50" />
        <path
          className="code-empty-home-connector-growth"
          d="M84 0C84 24 88 43 92 50"
          mask="url(#code-empty-home-target-mask)"
        />
      </svg>
      <header className="code-empty-home-header">
        <h2>{copy.emptyWorkspaceWelcome}</h2>
        <p>{copy.emptyWorkspaceWelcomeDescription}</p>
      </header>
      <div className="code-empty-home-action-map">
        <span className="code-empty-home-target-brace" data-testid="code-empty-home-target-brace" aria-hidden="true">
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
  activeView,
  showFileEditor,
  openWorkspaceFile,
  openWorkspaceFiles,
  openAgentsCount,
  openAgents,
  activeTerminalId,
  permissionSwitchingAgentId,
  agentSwitchingKind,
  terminalFocusRequest,
  agentCreationWorkspace,
  displayedProjects,
  searchQuery,
  searchHasQuery,
  searchLoading,
  visibleSearchTargetCount,
  selectedSearchAgentId,
  selectedSearchSessionHandle,
  searchInputRef,
  archivedRuns,
  archivedAgents,
  historyAgentSessions,
  canLoadMoreHistoryAgentSessions,
  now,
  composerProps,
  acpComposerProps,
  onNewAgent,
  onOpenHistory,
  onOpenSearch,
  onOpenShare,
  onOpenAppMode,
  onCollapseSidebar,
  onOpenTerminal,
  onOpenTerminalPath,
  onResolveTerminalPath,
  onTerminalFollowOutputChange,
  onAgentReadLatest,
  onRuntimeModeChange,
  onSessionOutput,
  onOpenSearchAgent,
  onOpenSearchSession,
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
  onSelectOpenWorkspaceFile,
  onOpenWorkspaceFilePath,
  canNavigateWorkspaceBack,
  canNavigateWorkspaceForward,
  onNavigateWorkspaceHistory,
  onCloseOpenWorkspaceFile,
  onCloseOpenWorkspaceFiles,
  onRevealWorkspaceFileInExplorer,
  onFocusWorkspaceFilesSearch,
  onRecordWorkspaceNavigationCursor,
  onBackToAgentFromFile,
  copy,
}: CodeMainAreaProps) {
  const [terminalComposerCollapsed, setTerminalComposerCollapsed] = useState(readTerminalComposerCollapsed)
  const [chatComposerCollapseRequested, setChatComposerCollapseRequested] = useState(false)
  const [runtimeSwitchExpandedAgentId, setRuntimeSwitchExpandedAgentId] = useState<string | null>(null)
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
    let active = true
    preloadFileEditorPane(component => {
      if (active) setFileEditorPane(() => component)
    })
    return () => {
      active = false
    }
  }, [])

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
  const agentWorkspaceVisible = activeView === 'projects'
    && !(showFileEditor && openWorkspaceFile)
  const acpComposerActive = isAcpRuntime(activeAgent)
  const terminalComposerActive = activeAgent?.runtimeBinding.kind === 'terminal'
  const composerCollapseRequested = terminalComposerActive
    ? (runtimeSwitchExpandedAgentId === activeAgent?.id ? false : terminalComposerCollapsed)
    : chatComposerCollapseRequested
  const canCollapseComposer = composerCollapseSupported
    && activeView === 'projects'
    && !showFileEditor
    && openAgentsCount > 0
  const composerCollapsed = canCollapseComposer && composerCollapseRequested

  useLayoutEffect(() => {
    const previous = previousActiveRuntimeRef.current
    const currentKind = acpComposerActive ? 'acp' : terminalComposerActive ? 'terminal' : null
    if (
      previous.kind === 'acp'
      && currentKind === 'terminal'
      && activeAgent?.id
      && replacesAgent(activeAgent, previous.agentId)
    ) {
      // Runtime switching replaces the Agent id. Preserve the visible Chat
      // composer for that replacement without changing the user's normal
      // preference for newly opened Terminal sessions.
      setRuntimeSwitchExpandedAgentId(activeAgent.id)
    }
    previousActiveRuntimeRef.current = { agentId: activeAgent?.id ?? null, kind: currentKind }
  }, [acpComposerActive, activeAgent?.id, terminalComposerActive])

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
      className="code-main"
      data-testid="code-main"
      onPointerDownCapture={dismissComposerKeyboardOnMainPress}
      onTouchStartCapture={dismissComposerKeyboardOnMainPress}
    >
      {activeView !== 'projects' ? (
        <section
          className={`code-side-view-panel ${activeView === 'search' ? 'code-search-view' : ''} ${activeView === 'history' ? 'code-history-view' : ''}`}
          data-testid="code-side-view-panel"
        >
          {activeView === 'search' ? (
            <SearchPanel
              query={searchQuery}
              displayedProjects={displayedProjects}
              hasQuery={searchHasQuery}
              loading={searchLoading}
              resultCount={visibleSearchTargetCount}
              selectedAgentId={selectedSearchAgentId}
              selectedSessionHandle={selectedSearchSessionHandle}
              inputRef={searchInputRef}
              onQueryChange={onSearchQueryChange}
              onKeyDown={onSearchKeyDown}
              onClearSearch={onCloseSearch}
              onBack={onCloseSearch}
              onOpenAgent={onOpenSearchAgent}
              onOpenSession={onOpenSearchSession}
              copy={copy}
            />
          ) : activeView === 'history' ? (
            <HistoryPanel
              archivedRuns={archivedRuns}
              archivedAgents={archivedAgents}
              agentSessions={historyAgentSessions}
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
          ) : (
            <h2>{viewTitle(copy, activeView)}</h2>
          )}
        </section>
      ) : showFileEditor && openWorkspaceFile ? (
        ReadyFileEditorPane ? (
          <ReadyFileEditorPane
            openFile={openWorkspaceFile}
            openFiles={openWorkspaceFiles}
            onChangeDraft={onChangeWorkspaceFileDraft}
            onUpdateOpenFile={onUpdateOpenWorkspaceFile}
            onSelectOpenFile={onSelectOpenWorkspaceFile}
            onOpenFilePath={onOpenWorkspaceFilePath}
            canNavigateBack={canNavigateWorkspaceBack}
            canNavigateForward={canNavigateWorkspaceForward}
            onNavigateHistory={onNavigateWorkspaceHistory}
            onCloseOpenFile={onCloseOpenWorkspaceFile}
            onCloseOpenFiles={onCloseOpenWorkspaceFiles}
            onRevealInExplorer={onRevealWorkspaceFileInExplorer}
            onFocusFilesSearch={onFocusWorkspaceFilesSearch}
            onRecordNavigationCursor={onRecordWorkspaceNavigationCursor}
            onBackToAgent={onBackToAgentFromFile}
            copy={copy}
          />
        ) : (
          <FileEditorFallback openFile={openWorkspaceFile} onChangeDraft={onChangeWorkspaceFileDraft} copy={copy} />
        )
      ) : null}

      <div
        className="code-terminal-grid panes-1"
        data-testid="code-terminal-grid"
        hidden={!agentWorkspaceVisible}
      >
        {openAgentsCount === 0 ? (
          <div className="code-empty-workspace code-empty-home-state" data-testid="code-empty-workspace">
            <EmptyWorkspaceGuide
              agentCreationWorkspace={agentCreationWorkspace}
              onNewAgent={onNewAgent}
              onOpenHistory={onOpenHistory}
              onOpenSearch={onOpenSearch}
              onOpenShare={onOpenShare}
              onOpenAppMode={onOpenAppMode}
              onCollapseSidebar={onCollapseSidebar}
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
              </div>
            </div>
          </div>
        ) : (
          openAgents.map(agent => (
            <AgentWorkPane
              key={agent.id}
              agent={agent}
              active={agentWorkspaceVisible && agent.id === activeTerminalId}
              viewportLayoutKey={composerCollapsed ? 'composer-collapsed' : 'composer-expanded'}
              switching={agent.id === permissionSwitchingAgentId}
              switchingKind={agent.id === permissionSwitchingAgentId ? agentSwitchingKind : null}
              onActivate={onOpenTerminal}
              onOpenPath={onOpenTerminalPath}
              onResolvePath={onResolveTerminalPath}
              onOpenWorkspaceFilePath={onOpenWorkspaceFilePath}
              onFollowOutputChange={onTerminalFollowOutputChange}
              onReadLatest={onAgentReadLatest}
              onRuntimeModeChange={onRuntimeModeChange}
              onSessionOutput={onSessionOutput}
              focusSignal={terminalFocusRequest?.agentId === agent.id ? terminalFocusRequest.nonce : 0}
              copy={copy}
            />
          ))
        )}
      </div>

      {agentWorkspaceVisible ? (
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
