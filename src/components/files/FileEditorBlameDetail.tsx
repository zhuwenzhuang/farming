import {
  formatWorkspaceBlameTime as formatBlameTime,
  workspaceBlameMessageParts,
} from '@/lib/workspace-editor-model'
import type { WorkspaceFileBlame, WorkspaceIssueLinkRule } from '@/lib/workspace-files'
import type { CodeCopy } from '../code/copy'

type WorkspaceFileBlameLine = WorkspaceFileBlame['lines'][number]

interface FileEditorBlameDetailProps {
  filePath: string
  line: WorkspaceFileBlameLine
  authorProfileUrl: string
  commitUrl: string
  issueLinkRules: readonly WorkspaceIssueLinkRule[]
  copy: CodeCopy
  onClose: () => void
}

export function FileEditorBlameDetail({
  filePath,
  line,
  authorProfileUrl,
  commitUrl,
  issueLinkRules,
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
          <strong>
            {workspaceBlameMessageParts(line.summary || line.shortCommit, issueLinkRules).map((part, index) => (
              part.url ? (
                <a
                  className="code-file-blame-detail-issue-link"
                  href={part.url}
                  key={`${index}:${part.text}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {part.text}
                </a>
              ) : part.text
            ))}
          </strong>
          {commitUrl ? (
            <a className="code-file-blame-detail-commit-link" href={commitUrl} target="_blank" rel="noreferrer" title={line.commit}>
              <code>{line.shortCommit}</code>
            </a>
          ) : (
            <code title={line.commit}>{line.shortCommit}</code>
          )}
        </div>
        <div className="code-file-blame-detail-subtitle" title={filePath}>
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
          {commitUrl ? (
            <a href={commitUrl} target="_blank" rel="noreferrer" title={line.commit}>{line.shortCommit}</a>
          ) : (
            <strong title={line.commit}>{line.shortCommit}</strong>
          )}
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
