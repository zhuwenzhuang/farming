import { iconForFilePath } from '@/lib/file-icons'
import { parentDirectory } from '@/lib/workspace-file-tree'
import { workspaceWorkingCopyChangeIndicator } from '@/lib/workspace-working-copy'
import type { CodeCopy } from '../code/copy'

export interface OpenProjectFileSummary {
  agentId: string
  workspaceRoot?: string
  key: string
  path: string
  dirty?: boolean
  externalChanged?: boolean
}

interface OpenEditorsSectionProps {
  activeFilePath?: string
  collapsed: boolean
  copy: CodeCopy
  files: OpenProjectFileSummary[]
  projectId: string
  onCloseOpenFile?: (agentId: string, filePath: string, workspaceRoot?: string) => void
  onSelectOpenFile?: (agentId: string, filePath: string) => boolean
  onToggleCollapsed: () => void
}

function basename(filePath: string) {
  return filePath.split('/').filter(Boolean).pop() || filePath
}

export function OpenEditorsSection({
  activeFilePath,
  collapsed,
  copy,
  files,
  projectId,
  onCloseOpenFile,
  onSelectOpenFile,
  onToggleCollapsed,
}: OpenEditorsSectionProps) {
  if (files.length === 0) return null

  return (
    <div className={`code-open-editors ${collapsed ? 'collapsed' : ''}`} data-testid="code-open-editors" data-project-id={projectId}>
      <div className="code-open-editors-header">
        <button
          type="button"
          className="code-open-editors-title"
          aria-expanded={!collapsed}
          onClick={onToggleCollapsed}
        >
          <span className={`code-file-section-chevron ${collapsed ? 'collapsed' : 'expanded'}`} aria-hidden="true" />
          <span>{copy.openEditors}</span>
        </button>
      </div>
      {!collapsed && (
        <div className="code-open-editors-list">
          {files.map(file => {
            const active = activeFilePath === file.path
            const changeIndicator = workspaceWorkingCopyChangeIndicator(file)
            return (
              <div
                key={file.key}
                className={`code-open-editor-row ${active ? 'active' : ''}`}
                data-testid="code-open-editor-row"
                title={file.path}
              >
                <button
                  type="button"
                  className="code-open-editor-main"
                  onClick={() => onSelectOpenFile?.(file.agentId, file.path)}
                >
                  <img className="code-file-type-icon file" src={iconForFilePath(file.path)} alt="" aria-hidden="true" />
                  <span className="code-open-editor-name">{basename(file.path)}</span>
                  <span className="code-open-editor-path">{parentDirectory(file.path)}</span>
                  {changeIndicator && (
                    <span className={`code-open-editor-state ${changeIndicator}`} title={changeIndicator === 'external' ? copy.changedOnDisk : copy.unsavedChanges} />
                  )}
                </button>
                {onCloseOpenFile && (
                  <button
                    type="button"
                    className="code-open-editor-close"
                    aria-label={copy.closeFile(file.path)}
                    title={copy.closeFile(file.path)}
                    onClick={() => onCloseOpenFile(file.agentId, file.path, file.workspaceRoot)}
                  />
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
