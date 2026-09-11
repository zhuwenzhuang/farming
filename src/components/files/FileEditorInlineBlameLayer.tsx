import type { MouseEvent } from 'react'
import type { FileEditorBlameOverlayState } from './useFileEditorBlameOverlayController'
import {
  workspaceBlameInlineLabel as formatBlameInlineLabel,
  type WorkspaceEditorBlameOverlayRow,
} from '@/lib/workspace-editor-model'
import type { WorkspaceFileBlame } from '@/lib/workspace-files'
import type { CodeCopy } from '../code/copy'

type WorkspaceFileBlameLine = WorkspaceFileBlame['lines'][number]

interface FileEditorInlineBlameLayerProps {
  viewport: FileEditorBlameOverlayState['viewport']
  left: number
  width: number
  rows: WorkspaceEditorBlameOverlayRow<WorkspaceFileBlameLine>[]
  copy: CodeCopy
  onShowDetail: (line: WorkspaceFileBlameLine) => void
  onContextMenu: (event: MouseEvent, lineNumber: number) => void
}

export function FileEditorInlineBlameLayer({
  viewport,
  left,
  width,
  rows,
  copy,
  onShowDetail,
  onContextMenu,
}: FileEditorInlineBlameLayerProps) {
  if (rows.length === 0) return null

  return (
    <div
      className="code-file-inline-blame-layer"
      aria-label={copy.gitBlameAnnotations}
      style={{ left: viewport.left, top: viewport.top, width: viewport.width, height: viewport.height, clipPath: `inset(${viewport.stickyHeight}px 0 0 0)` }}
    >
      {rows.map(({ line, top }) => (
        <button
          key={`${line.lineNumber}-${line.commit}-${line.author}`}
          type="button"
          data-line-number={line.lineNumber}
          className={`code-file-inline-blame ${line.uncommitted ? 'uncommitted' : ''}`}
          style={{ left, top, width }}
          title={`${line.shortCommit} ${line.author || copy.unknown} ${line.summary}`}
          onContextMenu={event => onContextMenu(event, line.lineNumber)}
          onClick={event => {
            event.preventDefault()
            event.stopPropagation()
            onShowDetail(line)
          }}
        >
          {formatBlameInlineLabel(line)}
        </button>
      ))}
    </div>
  )
}
