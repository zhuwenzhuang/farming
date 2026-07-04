import {
  workspaceBlameInlineLabel as formatBlameInlineLabel,
  type WorkspaceEditorBlameOverlayRow,
} from '@/lib/workspace-editor-model'
import type { WorkspaceFileBlame } from '@/lib/workspace-files'
import type { CodeCopy } from '../code/copy'

type WorkspaceFileBlameLine = WorkspaceFileBlame['lines'][number]

interface FileEditorInlineBlameLayerProps {
  left: number
  width: number
  rows: WorkspaceEditorBlameOverlayRow<WorkspaceFileBlameLine>[]
  copy: CodeCopy
  onShowDetail: (line: WorkspaceFileBlameLine) => void
}

export function FileEditorInlineBlameLayer({
  left,
  width,
  rows,
  copy,
  onShowDetail,
}: FileEditorInlineBlameLayerProps) {
  if (rows.length === 0) return null

  return (
    <div className="code-file-inline-blame-layer" aria-label={copy.gitBlameAnnotations}>
      {rows.map(({ line, top }) => (
        <button
          key={`${line.lineNumber}-${line.commit}-${line.author}`}
          type="button"
          className={`code-file-inline-blame ${line.uncommitted ? 'uncommitted' : ''}`}
          style={{ left, top, width }}
          title={`${line.shortCommit} ${line.author || copy.unknown} ${line.summary}`}
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
