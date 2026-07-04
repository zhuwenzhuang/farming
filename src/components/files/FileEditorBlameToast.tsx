import type { WorkspaceFileBlame } from '@/lib/workspace-files'
import type { CodeCopy } from '../code/copy'

interface FileEditorBlameToastProps {
  blame: WorkspaceFileBlame | null
  loading: boolean
  error: string | null
  copy: CodeCopy
}

export function FileEditorBlameToast({
  blame,
  loading,
  error,
  copy,
}: FileEditorBlameToastProps) {
  if (!loading && !error && (!blame || (blame.isGitRepo && blame.lines.length > 0))) {
    return null
  }

  return (
    <div className={`code-file-blame-toast ${error ? 'error' : ''}`} data-testid="code-file-blame-state">
      {loading
        ? copy.loadingBlame
        : error
          ? error
          : blame && !blame.isGitRepo
            ? copy.notGitRepository
            : copy.noCommittedLines}
    </div>
  )
}
