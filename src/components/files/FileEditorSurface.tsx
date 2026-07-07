import { useRef, type RefObject } from 'react'
import {
  workspaceEditorSurfaceState,
  type WorkspaceEditorFileMode,
} from '@/lib/workspace-editor-model'
import type { OpenWorkspaceFile, WorkspaceFileOpenTarget } from '@/lib/workspace-open-files'
import type { WorkspaceFileBlame } from '@/lib/workspace-files'
import type { CodeCopy } from '../code/copy'
import { FileEditorBlameDetail } from './FileEditorBlameDetail'
import { FileEditorDiffView } from './FileEditorDiffView'
import { FileEditorInlineBlameLayer } from './FileEditorInlineBlameLayer'
import { FileEditorLineChangesPanel } from './FileEditorLineChangesPanel'
import { FileEditorMarkdownPreview } from './FileEditorMarkdownPreview'
import { FileEditorPreviewPanel } from './FileEditorPreviewPanel'
import type { FileEditorBlameOverlayState } from './useFileEditorBlameOverlayController'
import type { FileEditorDiffState } from './useFileEditorDiffController'
import type { FileEditorLineChangesState } from './useFileEditorLineChangesController'

type FileEditorCursorPosition = {
  lineNumber: number
  column: number
}

type FileEditorBlameLine = WorkspaceFileBlame['lines'][number]

interface FileEditorSurfaceProps {
  activeTabDomId: string
  blame: WorkspaceFileBlame | null
  blameAuthorProfileUrl: string
  blameDetailLine: FileEditorBlameLine | null
  blameOpen: boolean
  blameOverlay: FileEditorBlameOverlayState
  copy: CodeCopy
  cursorPosition: FileEditorCursorPosition
  diffState: FileEditorDiffState
  editorMode: WorkspaceEditorFileMode
  editorHostRef: RefObject<HTMLDivElement | null>
  lineChanges: FileEditorLineChangesState | null
  markdownSplitOpen: boolean
  markdownPreviewOpen: boolean
  sourcePreviewOpen: boolean
  openFile: OpenWorkspaceFile
  onClearBlameDetail: () => void
  onCloseLineChanges: () => void
  onCloseDiff: () => void
  onOpenFilePath: (agentId: string, filePath: string, target?: WorkspaceFileOpenTarget) => Promise<void> | void
  onShowBlameDetail: (line: FileEditorBlameLine) => void
}

export function FileEditorSurface({
  activeTabDomId,
  blame,
  blameAuthorProfileUrl,
  blameDetailLine,
  blameOpen,
  blameOverlay,
  copy,
  cursorPosition,
  diffState,
  editorMode,
  editorHostRef,
  lineChanges,
  markdownSplitOpen,
  markdownPreviewOpen,
  sourcePreviewOpen,
  openFile,
  onClearBlameDetail,
  onCloseLineChanges,
  onCloseDiff,
  onOpenFilePath,
  onShowBlameDetail,
}: FileEditorSurfaceProps) {
  const surface = workspaceEditorSurfaceState({
    diffOnly: editorMode.diffOnly,
    diffOpen: diffState.open,
    markdownSplitOpen,
    markdownPreviewOpen,
    sourcePreviewOpen,
    visualPreview: editorMode.visualPreview,
  })
  const markdownPreviewRef = useRef<HTMLElement | null>(null)
  const showEditorStatusbar = surface.showEditorOverlays || surface.showMarkdownPreview

  return (
    <>
      {surface.showDiffView && (
        <FileEditorDiffView
          openFile={openFile}
          diffState={diffState}
          copy={copy}
          onClose={onCloseDiff}
        />
      )}
      <div
        className={`code-file-editor-source-region ${surface.showMarkdownSplit ? 'markdown-split' : ''} ${surface.showMonaco || surface.showMarkdownSplit ? '' : 'hidden'}`.trim()}
        data-testid={surface.showMarkdownSplit ? 'code-file-markdown-split' : undefined}
      >
        <div
          id="code-file-editor-panel"
          ref={editorHostRef}
          className="code-file-monaco"
          data-testid="code-file-monaco"
          role="tabpanel"
          aria-labelledby={activeTabDomId}
          tabIndex={-1}
        />
        {surface.showMarkdownSplit && (
          <FileEditorMarkdownPreview
            ref={markdownPreviewRef}
            activeTabDomId={activeTabDomId}
            openFile={openFile}
            onOpenFilePath={onOpenFilePath}
            copy={copy}
          />
        )}
      </div>
      {surface.showDiffOnlyPreview && (
        <section
          className="code-file-preview-panel metadata"
          data-testid="code-file-preview-panel"
          role="tabpanel"
          aria-labelledby={activeTabDomId}
          tabIndex={-1}
        >
          <div className="code-file-diff-state">{copy.deletedFileDiffOnly}</div>
        </section>
      )}
      {surface.showMarkdownPreview && (
        <FileEditorMarkdownPreview
          activeTabDomId={activeTabDomId}
          openFile={openFile}
          onOpenFilePath={onOpenFilePath}
          copy={copy}
        />
      )}
      {surface.showEditorOverlays && blameOpen && blame?.isGitRepo && (
        <FileEditorInlineBlameLayer
          left={blameOverlay.left}
          width={blameOverlay.width}
          rows={blameOverlay.rows}
          copy={copy}
          onShowDetail={onShowBlameDetail}
        />
      )}
      <FileEditorPreviewPanel
        openFile={openFile}
        activeTabDomId={activeTabDomId}
        copy={copy}
        sourcePreviewOpen={surface.showSourcePreview}
      />
      {surface.showEditorOverlays && blameOpen && blameDetailLine && (
        <FileEditorBlameDetail
          filePath={openFile.file.path}
          line={blameDetailLine}
          authorProfileUrl={blameAuthorProfileUrl}
          copy={copy}
          onClose={onClearBlameDetail}
        />
      )}
      {surface.showEditorOverlays && lineChanges && (
        <FileEditorLineChangesPanel
          mode={lineChanges.mode}
          lineNumber={lineChanges.lineNumber}
          loading={lineChanges.loading}
          error={lineChanges.error}
          changes={lineChanges.changes}
          copy={copy}
          onClose={onCloseLineChanges}
        />
      )}
      {showEditorStatusbar && (
        <div className="code-file-editor-statusbar" data-testid="code-file-editor-statusbar">
          <span className="code-file-editor-cursor-position">{copy.cursorPosition(cursorPosition.lineNumber, cursorPosition.column)}</span>
        </div>
      )}
    </>
  )
}
