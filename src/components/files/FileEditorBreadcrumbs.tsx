import { useMemo } from 'react'
import {
  workspaceEditorPathSegments as pathSegments,
  workspaceEditorPathToSegment as pathToSegment,
} from '@/lib/workspace-editor-model'
import type { OpenWorkspaceFile } from '@/lib/workspace-open-files'
import type { CodeCopy } from '../code/copy'

interface FileEditorBreadcrumbsProps {
  openFile: OpenWorkspaceFile
  copy: CodeCopy
  onRevealInExplorer: (agentId: string, filePath: string, kind: 'directory' | 'file') => void
}

export function FileEditorBreadcrumbs({
  openFile,
  copy,
  onRevealInExplorer,
}: FileEditorBreadcrumbsProps) {
  const filePathSegments = useMemo(() => pathSegments(openFile.file.path), [openFile.file.path])

  if (filePathSegments.length <= 1) return <span aria-hidden="true" />

  return (
    <nav className="code-file-editor-breadcrumbs" title={openFile.file.path} aria-label={copy.filePath}>
      {filePathSegments.map((segment, index, segments) => {
        const current = index === segments.length - 1
        const segmentPath = pathToSegment(segments, index)
        return (
          <button
            type="button"
            key={`${index}-${segment}`}
            className={`code-file-editor-breadcrumb ${current ? 'current' : ''}`}
            onClick={() => onRevealInExplorer(openFile.agentId, segmentPath, current ? 'file' : 'directory')}
            aria-label={copy.revealInExplorer(segmentPath)}
          >
            <span className="code-file-editor-breadcrumb-name">{segment}</span>
            {!current && (
              <span className="code-file-editor-breadcrumb-separator" aria-hidden="true" />
            )}
          </button>
        )
      })}
    </nav>
  )
}
