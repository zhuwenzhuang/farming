import { useMemo } from 'react'
import {
  workspaceEditorPathSegments as pathSegments,
  workspaceEditorPathToSegment as pathToSegment,
  workspaceEditorWorkspaceLabel as workspaceLabel,
} from '@/lib/workspace-editor-model'
import { iconForFilePath } from '@/lib/file-icons'
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
  const projectLabel = workspaceLabel(openFile.workspaceRoot)
  const breadcrumbTitle = openFile.workspaceRoot
    ? `${openFile.workspaceRoot.replace(/[\\/]+$/, '')}/${openFile.file.path}`
    : openFile.file.path

  if (filePathSegments.length === 0) return <span aria-hidden="true" />

  return (
    <nav className="code-file-editor-breadcrumbs" title={breadcrumbTitle} aria-label={copy.filePath}>
      {projectLabel && (
        <button
          type="button"
          className="code-file-editor-breadcrumb root"
          onClick={() => onRevealInExplorer(openFile.agentId, '', 'directory')}
          aria-label={copy.revealInExplorer(projectLabel)}
        >
          <span className="code-file-editor-breadcrumb-name">{projectLabel}</span>
          <span className="code-file-editor-breadcrumb-separator" aria-hidden="true" />
        </button>
      )}
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
            {current && (
              <img
                className="code-file-editor-breadcrumb-file-icon"
                src={iconForFilePath(openFile.file.path)}
                alt=""
                aria-hidden="true"
              />
            )}
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
