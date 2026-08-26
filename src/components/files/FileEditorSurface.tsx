import { useRef, type RefObject } from 'react'
import { LocalErrorBoundary, LocalRenderFault } from '@/components/LocalErrorBoundary'
import { RefreshGlyph } from '@/components/IconGlyphs'
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
import type { FileEditorModelStatus } from './useFileEditorMonacoController'

type FileEditorCursorPosition = {
  lineNumber: number
  column: number
}

type FileEditorBlameLine = WorkspaceFileBlame['lines'][number]

interface FileEditorSurfaceProps {
  activeTabDomId: string
  blame: WorkspaceFileBlame | null
  blameAuthorProfileUrl: string
  blameCommitUrl: string
  blameDetailLine: FileEditorBlameLine | null
  blameOpen: boolean
  blameOverlay: FileEditorBlameOverlayState
  copy: CodeCopy
  cursorPosition: FileEditorCursorPosition
  diffState: FileEditorDiffState
  editorMode: WorkspaceEditorFileMode
  editorHostRef: RefObject<HTMLDivElement | null>
  lineChanges: FileEditorLineChangesState | null
  modelStatus: FileEditorModelStatus
  markdownSplitOpen: boolean
  markdownPreviewOpen: boolean
  markdownReadingScrollTop: number
  sourcePreviewOpen: boolean
  previewRefreshRevision: number
  openFile: OpenWorkspaceFile
  onClearBlameDetail: () => void
  onCloseLineChanges: () => void
  onCloseDiff: () => void
  onMarkdownReadingPositionChange: (scrollTop: number) => void
  onOpenFilePath: (agentId: string, filePath: string, target?: WorkspaceFileOpenTarget) => Promise<void> | void
  onShowBlameDetail: (line: FileEditorBlameLine) => void
}

function filePreviewResetKey(openFile: OpenWorkspaceFile) {
  return [
    openFile.agentId,
    openFile.workspaceRoot,
    openFile.file.path,
    openFile.file.sha1 || '',
    String(openFile.revision),
  ].join('\u0000')
}

function FilePreviewRenderError({
  activeTabDomId,
  copy,
  onRetry,
}: {
  activeTabDomId: string
  copy: CodeCopy
  onRetry: () => void
}) {
  return (
    <section
      className="code-file-preview-panel"
      data-testid="code-file-preview-render-error"
      role="tabpanel"
      aria-labelledby={activeTabDomId}
      tabIndex={-1}
    >
      <div className="code-file-diff-state error" role="alert">
        <span>{copy.filesRefreshFailed}</span>
        <button
          type="button"
          className="code-file-editor-action reload"
          aria-label={copy.retry}
          title={copy.retry}
          onClick={onRetry}
        >
          <RefreshGlyph className="code-file-editor-action-svg" />
        </button>
      </div>
    </section>
  )
}

export function FileEditorSurface({
  activeTabDomId,
  blame,
  blameAuthorProfileUrl,
  blameCommitUrl,
  blameDetailLine,
  blameOpen,
  blameOverlay,
  copy,
  cursorPosition,
  diffState,
  editorMode,
  editorHostRef,
  lineChanges,
  modelStatus,
  markdownSplitOpen,
  markdownPreviewOpen,
  markdownReadingScrollTop,
  sourcePreviewOpen,
  previewRefreshRevision,
  openFile,
  onClearBlameDetail,
  onCloseLineChanges,
  onCloseDiff,
  onMarkdownReadingPositionChange,
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
  const hasEditorDiagnostics = modelStatus.errors > 0 || modelStatus.warnings > 0
  const showEditorStatusbar = hasEditorDiagnostics
    && (surface.showEditorOverlays || surface.showMarkdownPreview)
  const previewIdentity = `${openFile.agentId}:${openFile.file.path}`
  const previewResetKey = filePreviewResetKey(openFile)

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
          <LocalErrorBoundary
            label="file Markdown split preview"
            resetKey={previewResetKey}
            fallback={(_error, retry) => (
              <FilePreviewRenderError activeTabDomId={activeTabDomId} copy={copy} onRetry={retry} />
            )}
          >
            <LocalRenderFault surface="file-preview" identity={`${previewIdentity}:markdown`}>
              <FileEditorMarkdownPreview
                ref={markdownPreviewRef}
                activeTabDomId={activeTabDomId}
                openFile={openFile}
                onOpenFilePath={onOpenFilePath}
                initialScrollTop={markdownReadingScrollTop}
                onScrollTopChange={onMarkdownReadingPositionChange}
                copy={copy}
                previewRefreshRevision={previewRefreshRevision}
              />
            </LocalRenderFault>
          </LocalErrorBoundary>
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
        <LocalErrorBoundary
          label="file Markdown preview"
          resetKey={previewResetKey}
          fallback={(_error, retry) => (
            <FilePreviewRenderError activeTabDomId={activeTabDomId} copy={copy} onRetry={retry} />
          )}
        >
          <LocalRenderFault surface="file-preview" identity={`${previewIdentity}:markdown`}>
            <FileEditorMarkdownPreview
              activeTabDomId={activeTabDomId}
              openFile={openFile}
              onOpenFilePath={onOpenFilePath}
              initialScrollTop={markdownReadingScrollTop}
              onScrollTopChange={onMarkdownReadingPositionChange}
              copy={copy}
              previewRefreshRevision={previewRefreshRevision}
            />
          </LocalRenderFault>
        </LocalErrorBoundary>
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
      <LocalErrorBoundary
        label="file visual preview"
        resetKey={`${previewResetKey}\u0000${surface.showSourcePreview ? 'open' : 'closed'}`}
        fallback={(_error, retry) => (
          <FilePreviewRenderError activeTabDomId={activeTabDomId} copy={copy} onRetry={retry} />
        )}
      >
        <LocalRenderFault surface="file-preview" identity={`${previewIdentity}:visual`}>
          <FileEditorPreviewPanel
            openFile={openFile}
            activeTabDomId={activeTabDomId}
            copy={copy}
            sourcePreviewOpen={surface.showSourcePreview}
            previewRefreshRevision={previewRefreshRevision}
            visible={surface.showSourcePreview || editorMode.visualPreview}
          />
        </LocalRenderFault>
      </LocalErrorBoundary>
      {surface.showEditorOverlays && blameOpen && blameDetailLine && (
        <FileEditorBlameDetail
          filePath={openFile.file.path}
          line={blameDetailLine}
          authorProfileUrl={blameAuthorProfileUrl}
          commitUrl={blameCommitUrl}
          issueLinkRules={blame?.issueLinkRules ?? []}
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
          <div className="code-file-editor-statusbar-primary">
            <span
              className="code-file-editor-language"
              data-testid="code-file-editor-language"
              title={modelStatus.languageId}
            >
              {modelStatus.languageLabel}
            </span>
            <span className="code-file-editor-diagnostics" data-testid="code-file-editor-diagnostics">
              {modelStatus.errors > 0 ? (
                <span className="code-file-editor-problem error">{copy.editorErrorCount(modelStatus.errors)}</span>
              ) : null}
              {modelStatus.warnings > 0 ? (
                <span className="code-file-editor-problem warning">{copy.editorWarningCount(modelStatus.warnings)}</span>
              ) : null}
            </span>
          </div>
          <span className="code-file-editor-cursor-position">{copy.cursorPosition(cursorPosition.lineNumber, cursorPosition.column)}</span>
        </div>
      )}
    </>
  )
}
