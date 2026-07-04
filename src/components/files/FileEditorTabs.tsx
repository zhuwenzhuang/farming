import { type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react'
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
  onSetTabRef: (key: string, element: HTMLDivElement | null) => void
  onOpenTabContextMenu: (event: ReactMouseEvent<HTMLDivElement>, index: number) => void
  onTabAuxClick: (event: ReactMouseEvent<HTMLDivElement>, index: number) => void
  onTabKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>, index: number) => void
  onCloseTab: (index: number) => void
}

export function FileEditorTabs({
  openFile,
  openFiles,
  copy,
  onBackToAgent,
  onSelectOpenFile,
  onSetTabRef,
  onOpenTabContextMenu,
  onTabAuxClick,
  onTabKeyDown,
  onCloseTab,
}: FileEditorTabsProps) {
  return (
    <div className="code-file-editor-tab-strip">
      <button
        type="button"
        className="code-file-editor-action back code-file-editor-tab-back"
        onClick={() => onBackToAgent(openFile.agentId)}
        aria-label={copy.back}
        title={copy.back}
        data-testid="code-file-editor-back"
      />
      <div className="code-file-editor-tabs" role="tablist">
        {openFiles.map((file, index) => {
          const active = file.agentId === openFile.agentId && file.file.path === openFile.file.path
          const tabKey = openFileKey(file)
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
    </div>
  )
}
