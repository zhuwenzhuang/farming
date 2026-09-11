import { RefreshGlyph } from '@/components/IconGlyphs'
import type { WorkspaceFileBlame } from '@/lib/workspace-files'
import type { CodeCopy } from '../code/copy'

interface FileEditorBlameToastProps {
  blame: WorkspaceFileBlame | null
  loading: boolean
  error: string | null
  dirty: boolean
  onRetry: () => void
  copy: CodeCopy
}

export function FileEditorBlameToast({
  blame,
  loading,
  error,
  dirty,
  onRetry,
  copy,
}: FileEditorBlameToastProps) {
  if (!dirty && !loading && !error && (!blame || (blame.isGitRepo && blame.lines.length > 0))) {
    return null
  }

  return (
    <div className={`code-file-blame-toast ${!dirty && error ? 'error' : ''}`} data-testid="code-file-blame-state" role="status">
      {dirty
        ? copy.blameUnsavedChanges
        : loading
          ? copy.loadingBlame
          : error
            ? error
            : blame && !blame.isGitRepo
              ? copy.notGitRepository
              : copy.noCommittedLines}
      {!dirty && !loading && error && (
        <button type="button" className="code-file-editor-action" onClick={onRetry} aria-label={copy.retry} title={copy.retry}>
          <RefreshGlyph className="code-file-editor-action-svg" />
        </button>
      )}
    </div>
  )
}
