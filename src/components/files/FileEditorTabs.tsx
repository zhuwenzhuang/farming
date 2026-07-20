import { type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import { iconForFilePath } from '@/lib/file-icons'
import {
  workspaceEditorBasename as basename,
  workspaceEditorModelKey as openFileKey,
  workspaceEditorTabDomId as fileEditorTabDomId,
  workspaceEditorTabLabel as fileEditorTabLabel,
} from '@/lib/workspace-editor-model'
import type { OpenWorkspaceFile, WorkspaceFileOpenTarget } from '@/lib/workspace-open-files'
import {
  workspaceWorkingCopyChangeIndicator,
  workspaceWorkingCopyTabClass,
} from '@/lib/workspace-working-copy'
import type { CodeCopy } from '../code/copy'

interface FileEditorTabsProps {
  openFile: OpenWorkspaceFile
  openFiles: OpenWorkspaceFile[]
  copy: CodeCopy
  onBackToAgent: (agentId: string) => void
  onSelectOpenFile: (agentId: string, filePath: string, target?: WorkspaceFileOpenTarget) => boolean
  canNavigateBack: boolean
  canNavigateForward: boolean
  onNavigateHistory: (direction: -1 | 1) => boolean
  onSetTabRef: (key: string, element: HTMLDivElement | null) => void
  onOpenTabContextMenu: (event: ReactMouseEvent<HTMLDivElement>, index: number) => void
  onTabAuxClick: (event: ReactMouseEvent<HTMLDivElement>, index: number) => void
  onTabKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>, index: number) => void
  onCloseTab: (index: number) => void
  actions: ReactNode
}

function HistoryBackIcon() {
  return (
    <svg className="code-file-editor-action-svg" width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" focusable="false">
      <path d="M13.5 8.00023H3.70701L7.85301 3.85423C8.04801 3.65923 8.04801 3.34223 7.85301 3.14723C7.65801 2.95223 7.34101 2.95223 7.14601 3.14723L2.14601 8.14723C1.95101 8.34223 1.95101 8.65923 2.14601 8.85423L7.14601 13.8542C7.24401 13.9522 7.37201 14.0002 7.50001 14.0002C7.62801 14.0002 7.75601 13.9512 7.85401 13.8542C8.04901 13.6592 8.04901 13.3422 7.85401 13.1472L3.70801 9.00123H13.501C13.777 9.00123 14.001 8.77723 14.001 8.50123C14.001 8.22523 13.777 8.00123 13.501 8.00123L13.5 8.00023Z" />
    </svg>
  )
}

function HistoryForwardIcon() {
  return (
    <svg className="code-file-editor-action-svg" width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" focusable="false">
      <path d="M13.854 8.14576L8.854 3.14576C8.659 2.95076 8.342 2.95076 8.147 3.14576C7.952 3.34076 7.952 3.65776 8.147 3.85276L12.293 7.99876H2.5C2.224 7.99876 2 8.22276 2 8.49876C2 8.77476 2.224 8.99876 2.5 8.99876H12.293L8.147 13.1448C7.952 13.3398 7.952 13.6568 8.147 13.8518C8.245 13.9498 8.373 13.9978 8.501 13.9978C8.629 13.9978 8.757 13.9488 8.855 13.8518L13.855 8.85176C14.05 8.65676 14.05 8.33976 13.855 8.14476L13.854 8.14576Z" />
    </svg>
  )
}

function BackToAgentIcon() {
  return (
    <svg className="code-file-editor-action-svg" width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" focusable="false">
      <path d="M13 13.5C13 13.776 12.776 14 12.5 14C9.46198 14 6.99998 11.538 6.99998 8.50001V3.70701L4.35398 6.35301C4.15898 6.54801 3.84198 6.54801 3.64698 6.35301C3.45198 6.15801 3.45198 5.84101 3.64698 5.64601L7.14698 2.14601C7.34198 1.95101 7.65898 1.95101 7.85398 2.14601L11.354 5.64601C11.549 5.84101 11.549 6.15801 11.354 6.35301C11.159 6.54801 10.842 6.54801 10.647 6.35301L8.00098 3.70701V8.50001C8.00098 10.985 10.016 13 12.501 13C12.777 13 13.001 13.224 13.001 13.5H13Z" />
    </svg>
  )
}

export function FileEditorTabs({
  openFile,
  openFiles,
  copy,
  onBackToAgent,
  onSelectOpenFile,
  canNavigateBack,
  canNavigateForward,
  onNavigateHistory,
  onSetTabRef,
  onOpenTabContextMenu,
  onTabAuxClick,
  onTabKeyDown,
  onCloseTab,
  actions,
}: FileEditorTabsProps) {
  return (
    <div className="code-file-editor-tab-strip">
      <div className="code-file-editor-navigation">
        {openFile.sourceAgentId && (
          <>
            <button
              type="button"
              className="code-file-editor-action code-file-editor-agent-return"
              onClick={() => onBackToAgent(openFile.sourceAgentId!)}
              aria-label={copy.backToAgent}
              title={copy.backToAgent}
              data-testid="code-file-editor-back"
            >
              <BackToAgentIcon />
            </button>
            <span className="code-file-editor-navigation-divider" aria-hidden="true" />
          </>
        )}
        <button
          type="button"
          className="code-file-editor-action code-file-editor-history-back"
          onClick={() => {
            void onNavigateHistory(-1)
          }}
          disabled={!canNavigateBack}
          aria-label={copy.goBack}
          title={copy.goBack}
          data-testid="code-file-editor-history-back"
        >
          <HistoryBackIcon />
        </button>
        <button
          type="button"
          className="code-file-editor-action code-file-editor-history-forward"
          onClick={() => {
            void onNavigateHistory(1)
          }}
          disabled={!canNavigateForward}
          aria-label={copy.goForward}
          title={copy.goForward}
          data-testid="code-file-editor-history-forward"
        >
          <HistoryForwardIcon />
        </button>
      </div>
      <div className="code-file-editor-tabs" role="tablist">
        {openFiles.map((file, index) => {
          const tabKey = openFileKey(file)
          const active = tabKey === openFileKey(openFile)
          const tabStateClass = workspaceWorkingCopyTabClass(file)
          const changeIndicator = workspaceWorkingCopyChangeIndicator(file)
          return (
            <div
              id={fileEditorTabDomId(file)}
              key={tabKey}
              ref={element => onSetTabRef(tabKey, element)}
              className={`code-file-editor-tab ${active ? 'active' : ''} ${tabStateClass}`.trim()}
              title={file.file.path}
              role="tab"
              aria-selected={active}
              aria-controls="code-file-editor-panel"
              aria-label={fileEditorTabLabel(file)}
              tabIndex={active ? 0 : -1}
              onClick={() => onSelectOpenFile(file.agentId, file.file.path)}
              onContextMenu={event => onOpenTabContextMenu(event, index)}
              onAuxClick={event => onTabAuxClick(event, index)}
              onKeyDown={event => onTabKeyDown(event, index)}
            >
              <img className="code-file-type-icon file" src={iconForFilePath(file.file.path)} alt="" aria-hidden="true" />
              <span className="code-file-editor-tab-name">{basename(file.file.path)}</span>
              <span className="code-file-editor-tab-tail">
                {changeIndicator && (
                  <span className="code-file-editor-dirty" title={changeIndicator === 'external' ? copy.changedOnDisk : copy.unsavedChanges} />
                )}
                <button
                  type="button"
                  tabIndex={-1}
                  className="code-file-editor-close"
                  onClick={event => {
                    event.stopPropagation()
                    onCloseTab(index)
                  }}
                  aria-label={copy.closeFile(file.file.path)}
                />
              </span>
            </div>
          )
        })}
      </div>
      {actions}
    </div>
  )
}
