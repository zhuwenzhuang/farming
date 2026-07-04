import type { RefObject } from 'react'
import {
  workspaceEditorSurfaceState,
  type WorkspaceEditorFileMode,
} from '@/lib/workspace-editor-model'
import type { OpenWorkspaceFile } from '@/lib/workspace-open-files'
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
  markdownPreviewOpen: boolean
  openFile: OpenWorkspaceFile
  onClearBlameDetail: () => void
  onCloseLineChanges: () => void
  onCloseDiff: () => void
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
  markdownPreviewOpen,
  openFile,
  onClearBlameDetail,
  onCloseLineChanges,
  onCloseDiff,
  onShowBlameDetail,
}: FileEditorSurfaceProps) {
  const surface = workspaceEditorSurfaceState({
    diffOnly: editorMode.diffOnly,
    diffOpen: diffState.open,
    markdownPreviewOpen,
    visualPreview: editorMode.visualPreview,
  })

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
        id="code-file-editor-panel"
        ref={editorHostRef}
        className={`code-file-monaco ${surface.showMonaco ? '' : 'hidden'}`}
        data-testid="code-file-monaco"
        role="tabpanel"
        aria-labelledby={activeTabDomId}
        tabIndex={-1}
      />
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
      {surface.showEditorOverlays && (
        <div className="code-file-editor-statusbar" data-testid="code-file-editor-statusbar">
          <span className="code-file-editor-cursor-position">{copy.cursorPosition(cursorPosition.lineNumber, cursorPosition.column)}</span>
        </div>
      )}
    </>
  )
}
