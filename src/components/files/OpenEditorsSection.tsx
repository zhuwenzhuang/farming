import { useEffect, useMemo, useRef, type CSSProperties } from 'react'
import { iconForFilePath } from '@/lib/file-icons'
import { ChevronDownGlyph, ChevronRightGlyph } from '@/components/IconGlyphs'
import { parentDirectory } from '@/lib/workspace-file-tree'
import { workspaceWorkingCopyChangeIndicator } from '@/lib/workspace-working-copy'
import type { CodeCopy } from '../code/copy'

export const OPEN_EDITORS_VISIBLE_ROW_LIMIT = 7
export const OPEN_EDITORS_HEADER_HEIGHT = 25
export const OPEN_EDITOR_ROW_HEIGHT = 28

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
  onOpenFileContextMenu?: (x: number, y: number, file: OpenProjectFileSummary) => void
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
  onOpenFileContextMenu,
  onSelectOpenFile,
  onToggleCollapsed,
}: OpenEditorsSectionProps) {
  const listRef = useRef<HTMLDivElement | null>(null)
  const activeRowRef = useRef<HTMLDivElement | null>(null)
  const visibleRowCount = Math.min(files.length, OPEN_EDITORS_VISIBLE_ROW_LIMIT)
  const rootStyle = useMemo(() => ({
    '--code-open-editors-visible-rows': visibleRowCount,
    '--code-open-editors-list-max-height': `${visibleRowCount * OPEN_EDITOR_ROW_HEIGHT}px`,
  }) as CSSProperties, [visibleRowCount])

  useEffect(() => {
    if (collapsed) return
    const list = listRef.current
    const row = activeRowRef.current
    if (!list || !row) return

    const rowTop = row.offsetTop
    const rowBottom = rowTop + row.offsetHeight
    if (rowTop < list.scrollTop) {
      list.scrollTop = rowTop
    } else if (rowBottom > list.scrollTop + list.clientHeight) {
      list.scrollTop = rowBottom - list.clientHeight
    }
  }, [activeFilePath, collapsed, files.length])

  if (files.length === 0) return null

  return (
    <div
      className={`code-open-editors ${collapsed ? 'collapsed' : ''}`}
      data-testid="code-open-editors"
      data-project-id={projectId}
      data-open-editor-count={files.length}
      data-visible-editor-count={visibleRowCount}
      style={rootStyle}
    >
      <div className="code-open-editors-header">
        <button
          type="button"
          className="code-open-editors-title"
          aria-expanded={!collapsed}
          onClick={onToggleCollapsed}
        >
          <span className={`code-file-section-chevron ${collapsed ? 'collapsed' : 'expanded'}`} aria-hidden="true">
            {collapsed ? <ChevronRightGlyph /> : <ChevronDownGlyph />}
          </span>
          <span>{copy.openEditors}</span>
        </button>
      </div>
      {!collapsed && (
        <div ref={listRef} className="code-open-editors-list">
          {files.map(file => {
            const active = activeFilePath === file.path
            const changeIndicator = workspaceWorkingCopyChangeIndicator(file)
            return (
              <div
                key={file.key}
                ref={active ? activeRowRef : undefined}
                className={`code-open-editor-row ${active ? 'active' : ''}`}
                data-testid="code-open-editor-row"
                data-file-path={file.path}
                title={file.path}
                onContextMenu={event => {
                  if (!onOpenFileContextMenu) return
                  event.preventDefault()
                  onOpenFileContextMenu(event.clientX, event.clientY, file)
                }}
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
