import { useCallback, useEffect, useState, type ComponentProps, type KeyboardEvent as ReactKeyboardEvent, type RefObject, type SyntheticEvent as ReactSyntheticEvent } from 'react'
import type { Agent, TaskHistoryEntry } from '@/types/agent'
import { isAcpRuntime, isStructuredRuntime } from '@/lib/agent-runtime'
import type { TerminalPathOpenTarget } from '@/lib/terminal-session-pool'
import type { OpenWorkspaceFile, WorkspaceOpenFileTarget } from '@/lib/workspace-open-files'
import type { WorkspaceNavigationFileInput } from '@/lib/workspace-navigation-history'
import { isMobileTouchViewport } from '@/lib/responsive-mode'
import { AgentWorkPane } from './AgentWorkPane'
import { CodeComposer } from './CodeComposer'
import { AcpComposer } from './acp/AcpComposer'
import { CodexGoalControls } from './CodexGoalControls'
import { HistoryPanel } from './HistoryPanel'
import { SearchPanel } from './SearchPanel'
import { ChevronDownGlyph, ChevronUpGlyph } from '../IconGlyphs'
import type { CodeCopy } from './copy'
import type { AgentSessionHistoryItem, ProjectGroup, WorkspaceFileOpenTarget, WorkspaceView } from './types'

type ComposerProps = Omit<ComponentProps<typeof CodeComposer>, 'copy'>
type AcpComposerProps = Omit<ComponentProps<typeof AcpComposer>, 'copy'>
type TerminalFollowState = {
  following: boolean
  hasUnreadOutput: boolean
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

  return (
    <section
      className="code-file-editor fallback"
      data-testid="code-file-editor"
      aria-label={copy.editorFor(openFile.file.path)}
    >
      <header className="code-file-editor-header">
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
        <div className="code-file-editor-bar">
          <nav className="code-file-editor-breadcrumbs" title={openFile.file.path} aria-label={copy.filePath}>
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
  visibleOpenAgents: Agent[]
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
  onOpenTerminal: (agentId: string, options?: { focusTerminal?: boolean }) => void
  onOpenTerminalPath: (agentId: string, target: TerminalPathOpenTarget) => void
  onResolveTerminalPath: (agentId: string, target: TerminalPathOpenTarget) => Promise<TerminalPathOpenTarget | null> | TerminalPathOpenTarget | null
  onTerminalFollowOutputChange: (agentId: string, state: TerminalFollowState) => void
  onAgentReadLatest: (
    agentId: string,
    readCut?: { runtimeEpoch: string; outputSeq: number } | null,
  ) => void
  onRuntimeModeChange: (agentId: string, mode: 'terminal' | 'acp') => void
  onSessionOutput: (agentId: string, handler: (data: string, replace?: boolean, outputSeq?: number | null, runtimeEpoch?: string, stateRevision?: number | null, cols?: number, rows?: number, kind?: 'output' | 'resize' | 'clear') => void) => () => void
  onOpenSearchAgent: (agentId: string) => void
  onOpenSearchSession: (session: AgentSessionHistoryItem) => void
  onSearchQueryChange: (value: string) => void
  onSearchKeyDown: (event: ReactKeyboardEvent<HTMLInputElement>) => void
  onCloseSearch: () => void
  onLoadMoreHistoryAgentSessions: () => void
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

export function CodeMainArea({
  activeView,
  showFileEditor,
  openWorkspaceFile,
  openWorkspaceFiles,
  openAgentsCount,
  visibleOpenAgents,
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
  const [terminalComposerCollapsed, setTerminalComposerCollapsed] = useState(false)
  const [composerCollapseSupported, setComposerCollapseSupported] = useState(false)
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

  const loadMoreHistoryNearEnd = useCallback((element: HTMLElement) => {
    if (!canLoadMoreHistoryAgentSessions) return
    const remaining = element.scrollHeight - element.scrollTop - element.clientHeight
    if (remaining <= 320) onLoadMoreHistoryAgentSessions()
  }, [canLoadMoreHistoryAgentSessions, onLoadMoreHistoryAgentSessions])
  const activeAgent = activeTerminalId
    ? visibleOpenAgents.find(agent => agent.id === activeTerminalId) || null
    : null
  const acpComposerActive = isAcpRuntime(activeAgent)
  const activeWorkPaneMode = isStructuredRuntime(activeAgent)
    ? 'transcript'
    : 'terminal'
  const canCollapseComposer = composerCollapseSupported
    && activeView === 'projects'
    && !showFileEditor
    && openAgentsCount > 0
    && activeWorkPaneMode === 'terminal'
  const composerCollapsed = canCollapseComposer && terminalComposerCollapsed

  useEffect(() => {
    const mediaQuery = window.matchMedia('(hover: hover) and (pointer: fine)')
    const updateCollapseSupport = () => setComposerCollapseSupported(mediaQuery.matches)
    updateCollapseSupport()
    mediaQuery.addEventListener('change', updateCollapseSupport)
    return () => mediaQuery.removeEventListener('change', updateCollapseSupport)
  }, [])

  useEffect(() => {
    if (!canCollapseComposer && terminalComposerCollapsed) {
      setTerminalComposerCollapsed(false)
    }
  }, [canCollapseComposer, terminalComposerCollapsed])

  const dismissComposerKeyboardOnMainPress = useCallback((event: ReactSyntheticEvent<HTMLElement>) => {
    if (!isMobileTouchViewport()) return
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
          onScroll={activeView === 'history' ? event => loadMoreHistoryNearEnd(event.currentTarget) : undefined}
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
      ) : (
        <>
          <div
            className="code-terminal-grid panes-1"
            data-testid="code-terminal-grid"
          >
            {openAgentsCount === 0 ? (
              <div className="code-empty-workspace" data-testid="code-empty-workspace">
                <h2>{copy.startOrSelectAgent}</h2>
                <p>{copy.startOrSelectAgentDescription}</p>
                <button type="button" onClick={() => onNewAgent(agentCreationWorkspace)}>{copy.newAgent}</button>
              </div>
            ) : (
              visibleOpenAgents.map(agent => (
                <AgentWorkPane
                  key={agent.id}
                  agent={agent}
                  active={agent.id === activeTerminalId}
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

          {composerCollapsed ? (
            <div className="code-composer-restore-bar" data-testid="code-composer-restore-bar">
              <button
                type="button"
                className="code-composer-restore"
                data-testid="code-composer-restore"
                aria-label={copy.restoreComposer}
                title={copy.restoreComposer}
                onClick={() => setTerminalComposerCollapsed(false)}
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
                    onClick={() => setTerminalComposerCollapsed(true)}
                  >
                    <ChevronDownGlyph />
                  </button>
                </div>
              ) : null}
              {!acpComposerActive ? (
                <CodexGoalControls
                  agent={activeAgent}
                  active={activeView === 'projects' && !showFileEditor && !composerCollapsed}
                  copy={copy}
                />
              ) : null}
              {acpComposerActive ? (
                <AcpComposer {...acpComposerProps} copy={copy} />
              ) : (
                <CodeComposer {...composerProps} copy={copy} />
              )}
            </div>
          )}
        </>
      )}
    </main>
  )
}
