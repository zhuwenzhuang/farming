import { formatWorkspaceBlameTime as formatBlameTime } from '@/lib/workspace-editor-model'
import type { WorkspaceFileBlame } from '@/lib/workspace-files'
import type { CodeCopy } from '../code/copy'

type WorkspaceFileBlameLine = WorkspaceFileBlame['lines'][number]

interface FileEditorBlameDetailProps {
  filePath: string
  line: WorkspaceFileBlameLine
  authorProfileUrl: string
  copy: CodeCopy
  onClose: () => void
}

export function FileEditorBlameDetail({
  filePath,
  line,
  authorProfileUrl,
  copy,
  onClose,
}: FileEditorBlameDetailProps) {
  return (
    <section
      className="code-file-blame-detail"
      data-testid="code-file-blame-detail"
      aria-label={copy.gitBlameDetails}
    >
      <div className="code-file-blame-detail-main">
        <div className="code-file-blame-detail-title">
          <strong>{line.summary || line.shortCommit}</strong>
          <code title={line.commit}>{line.shortCommit}</code>
        </div>
        <div className="code-file-blame-detail-subtitle">
          {filePath}
        </div>
      </div>
      <div className="code-file-blame-detail-rows">
        <div className="code-file-blame-detail-row">
          <span>{copy.author}</span>
          {authorProfileUrl ? (
            <a href={authorProfileUrl} target="_blank" rel="noreferrer">
              {line.author}
            </a>
          ) : (
            <strong>{line.author || copy.unknown}</strong>
          )}
        </div>
        <div className="code-file-blame-detail-row">
          <span>{copy.commit}</span>
          <strong title={line.commit}>{line.shortCommit}</strong>
        </div>
        <div className="code-file-blame-detail-row">
          <span>{copy.date}</span>
          <strong>{formatBlameTime(line.authorTime) || copy.uncommitted}</strong>
        </div>
        <div className="code-file-blame-detail-row">
          <span>{copy.line}</span>
          <strong>{line.lineNumber}</strong>
        </div>
      </div>
      <button
        type="button"
        className="code-file-blame-detail-close"
        onClick={onClose}
        aria-label={copy.closeBlameDetails}
      />
    </section>
  )
}
