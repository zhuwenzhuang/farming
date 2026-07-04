import { workspaceEditorLineChangesPatchLineClassName } from '@/lib/workspace-editor-model'
import type { WorkspaceFileLineChanges } from '@/lib/workspace-files'
import type { CodeCopy } from '../code/copy'

interface FileEditorLineChangesPanelProps {
  mode: WorkspaceFileLineChanges['mode']
  lineNumber: number
  loading: boolean
  error: string | null
  changes: WorkspaceFileLineChanges | null
  copy: CodeCopy
  onClose: () => void
}

function lineChangesTitle(mode: WorkspaceFileLineChanges['mode'], copy: CodeCopy) {
  return mode === 'previous'
    ? copy.openLineChangesWithPreviousRevision
    : copy.openLineChangesWithWorkingFile
}

export function FileEditorLineChangesPanel({
  mode,
  lineNumber,
  loading,
  error,
  changes,
  copy,
  onClose,
}: FileEditorLineChangesPanelProps) {
  const commitLabel = changes?.commit
    ? `${changes.commit.shortHash} ${changes.commit.summary || ''}`.trim()
    : ''
  const statusText = loading
    ? copy.loadingLineChanges
    : error || (changes && !changes.available ? copy.noLineChanges : '')
  const patchLines = changes?.patch ? changes.patch.split('\n') : []

  return (
    <div className="code-file-line-changes-panel" data-testid="code-file-line-changes-panel">
      <div className="code-file-line-changes-main">
        <div className="code-file-line-changes-title">
          <strong>{lineChangesTitle(mode, copy)}</strong>
          <code>{copy.line} {lineNumber}</code>
        </div>
        {commitLabel && (
          <div className="code-file-line-changes-subtitle">{commitLabel}</div>
        )}
        {statusText && (
          <div className={`code-file-line-changes-state ${error ? 'error' : ''}`}>{statusText}</div>
        )}
        {!loading && !error && changes?.available && (
          <pre className="code-file-line-changes-patch" aria-label={copy.lineChanges}>
            {patchLines.map((line, index) => (
              <span key={`${index}-${line}`} className={`code-file-line-changes-line ${workspaceEditorLineChangesPatchLineClassName(line)}`}>
                {line || ' '}
              </span>
            ))}
          </pre>
        )}
      </div>
      <button
        type="button"
        className="code-file-line-changes-close"
        aria-label={copy.closeLineChanges}
        onClick={onClose}
      />
    </div>
  )
}
