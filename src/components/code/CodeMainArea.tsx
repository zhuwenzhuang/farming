import { lazy, Suspense, type ComponentProps } from 'react'
import type { Agent, TaskHistoryEntry } from '@/types/agent'
import type { TerminalInputPart } from '@/types/messages'
import type { TerminalPathOpenTarget } from '@/lib/terminal-session-pool'
import { AgentTerminalPane } from '../AgentTerminalPane'
import type { OpenWorkspaceFile, WorkspaceOpenFileTarget } from '@/lib/workspace-open-files'
import type { WorkspaceNavigationFileInput } from '@/lib/workspace-navigation-history'
import { CodeComposer } from './CodeComposer'
import { HistoryPanel } from './HistoryPanel'
import { SearchPanel } from './SearchPanel'
import type { CodeCopy } from './copy'
import type { AgentSessionHistoryItem, ProjectGroup, WorkspaceFileOpenTarget, WorkspaceView } from './types'

type ComposerProps = Omit<ComponentProps<typeof CodeComposer>, 'copy'>
type TerminalFollowState = {
  following: boolean
  hasUnreadOutput: boolean
}

function loadFileEditorPane() {
  return import('../files/FileEditorPane').then(module => ({
    default: module.FileEditorPane,
  }))
}

const FileEditorPane = lazy(() => loadFileEditorPane())

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
        value={openFile.draft}
        onChange={event => onChangeDraft(event.currentTarget.value)}
        spellCheck={false}
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
  terminalFocusRequest: { agentId: string; nonce: number } | null
  agentCreationWorkspace?: string
  displayedProjects: ProjectGroup[]
  searchHasQuery: boolean
  visibleSearchTargetCount: number
  selectedSearchAgentId: string | null
  selectedSearchSessionHandle: string | null
  archivedRuns: TaskHistoryEntry[]
  archivedAgents: Agent[]
  historyAgentSessions: AgentSessionHistoryItem[]
  now: number
  composerProps: ComposerProps
  onNewAgent: (workspace?: string, command?: string) => void
  onOpenTerminal: (agentId: string, options?: { focusTerminal?: boolean }) => void
  onOpenTerminalPath: (agentId: string, target: TerminalPathOpenTarget) => void
  onResolveTerminalPath: (agentId: string, target: TerminalPathOpenTarget) => Promise<TerminalPathOpenTarget | null> | TerminalPathOpenTarget | null
  onTerminalFollowOutputChange: (agentId: string, state: TerminalFollowState) => void
  sendInput: (input: string | TerminalInputPart[], agentId?: string) => boolean
  resizeAgent: (agentId: string, cols: number, rows: number) => boolean
  onSessionOutput: (agentId: string, handler: (data: string, replace?: boolean, outputSeq?: number | null) => void) => () => void
  onOpenSearchAgent: (agentId: string) => void
  onOpenSearchSession: (session: AgentSessionHistoryItem) => void
  onResumeHistorySession: (provider: string, sessionId: string) => void
  onContinueArchivedRun: (entry: TaskHistoryEntry) => void
  onOpenArchivedAgent: (agentId: string) => void
  onRestoreArchivedAgent: (agentId: string) => void
  onChangeWorkspaceFileDraft: (draft: string) => void
  onUpdateOpenWorkspaceFile: (nextFile: OpenWorkspaceFile) => void
  onSelectOpenWorkspaceFile: (agentId: string, filePath: string, target?: WorkspaceFileOpenTarget) => boolean
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
  terminalFocusRequest,
  agentCreationWorkspace,
  displayedProjects,
  searchHasQuery,
  visibleSearchTargetCount,
  selectedSearchAgentId,
  selectedSearchSessionHandle,
  archivedRuns,
  archivedAgents,
  historyAgentSessions,
  now,
  composerProps,
  onNewAgent,
  onOpenTerminal,
  onOpenTerminalPath,
  onResolveTerminalPath,
  onTerminalFollowOutputChange,
  sendInput,
  resizeAgent,
  onSessionOutput,
  onOpenSearchAgent,
  onOpenSearchSession,
  onResumeHistorySession,
  onContinueArchivedRun,
  onOpenArchivedAgent,
  onRestoreArchivedAgent,
  onChangeWorkspaceFileDraft,
  onUpdateOpenWorkspaceFile,
  onSelectOpenWorkspaceFile,
  onCloseOpenWorkspaceFile,
  onCloseOpenWorkspaceFiles,
  onRevealWorkspaceFileInExplorer,
  onFocusWorkspaceFilesSearch,
  onRecordWorkspaceNavigationCursor,
  onBackToAgentFromFile,
  copy,
}: CodeMainAreaProps) {
  return (
    <main className="code-main" data-testid="code-main">
      {activeView !== 'projects' ? (
        <section
          className={`code-side-view-panel ${activeView === 'search' ? 'code-search-view' : ''} ${activeView === 'history' ? 'code-history-view' : ''}`}
          data-testid="code-side-view-panel"
        >
          {activeView === 'search' ? (
            <SearchPanel
              displayedProjects={displayedProjects}
              hasQuery={searchHasQuery}
              resultCount={visibleSearchTargetCount}
              selectedAgentId={selectedSearchAgentId}
              selectedSessionHandle={selectedSearchSessionHandle}
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
              copy={copy}
            />
          ) : (
            <h2>{viewTitle(copy, activeView)}</h2>
          )}
        </section>
      ) : showFileEditor && openWorkspaceFile ? (
        <Suspense fallback={<FileEditorFallback openFile={openWorkspaceFile} onChangeDraft={onChangeWorkspaceFileDraft} copy={copy} />}>
          <FileEditorPane
            openFile={openWorkspaceFile}
            openFiles={openWorkspaceFiles}
            onChangeDraft={onChangeWorkspaceFileDraft}
            onUpdateOpenFile={onUpdateOpenWorkspaceFile}
            onSelectOpenFile={onSelectOpenWorkspaceFile}
            onCloseOpenFile={onCloseOpenWorkspaceFile}
            onCloseOpenFiles={onCloseOpenWorkspaceFiles}
            onRevealInExplorer={onRevealWorkspaceFileInExplorer}
            onFocusFilesSearch={onFocusWorkspaceFilesSearch}
            onRecordNavigationCursor={onRecordWorkspaceNavigationCursor}
            onBackToAgent={onBackToAgentFromFile}
            copy={copy}
          />
        </Suspense>
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
                <AgentTerminalPane
                  key={agent.id}
                  agent={agent}
                  active={agent.id === activeTerminalId}
                  onActivate={onOpenTerminal}
                  onOpenPath={onOpenTerminalPath}
                  onResolvePath={onResolveTerminalPath}
                  onFollowOutputChange={onTerminalFollowOutputChange}
                  sendInput={sendInput}
                  resizeAgent={resizeAgent}
                  onSessionOutput={onSessionOutput}
                  focusSignal={terminalFocusRequest?.agentId === agent.id ? terminalFocusRequest.nonce : 0}
                  copy={copy}
                />
              ))
            )}
          </div>

          <CodeComposer {...composerProps} copy={copy} />
        </>
      )}
    </main>
  )
}
