import type { OpenWorkspaceFile } from '@/lib/workspace-open-files'
import type { WorkspaceEditorActionState } from '@/lib/workspace-editor-model'
import type { CodeCopy } from '../code/copy'

function MarkdownPreviewIcon({ previewOpen }: { previewOpen: boolean }) {
  if (previewOpen) {
    return (
      <svg
        className="code-file-editor-action-svg"
        width="16"
        height="16"
        viewBox="0 0 16 16"
        fill="currentColor"
        aria-hidden="true"
        focusable="false"
      >
        <path d="M9 3.5V11.5C9 11.776 8.776 12 8.5 12C8.224 12 8 11.776 8 11.5V4.831L5.376 7.83C5.187 8.048 4.814 8.048 4.624 7.83L2 4.831V11.5C2 11.776 1.776 12 1.5 12C1.224 12 1 11.776 1 11.5V3.5C1 3.292 1.129 3.105 1.324 3.032C1.521 2.96 1.74 3.014 1.876 3.171L5 6.741L8.124 3.171C8.261 3.014 8.478 2.959 8.676 3.032C8.871 3.105 9 3.292 9 3.5ZM14.854 9.146C14.659 8.951 14.342 8.951 14.147 9.146L13.001 10.292V3.5C13.001 3.224 12.777 3 12.501 3C12.225 3 12.001 3.224 12.001 3.5V10.293L10.855 9.147C10.66 8.952 10.343 8.952 10.148 9.147C9.953 9.342 9.953 9.659 10.148 9.854L12.148 11.854C12.246 11.952 12.757 11.952 12.855 11.854L14.855 9.854C15.05 9.659 15.05 9.342 14.855 9.147L14.854 9.146Z" />
      </svg>
    )
  }

  return (
    <svg
      className="code-file-editor-action-svg"
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M12.5 1H3.5C2.122 1 1 2.122 1 3.5V12.5C1 13.878 2.122 15 3.5 15H12.5C13.878 15 15 13.878 15 12.5V3.5C15 2.122 13.878 1 12.5 1ZM14 12.5C14 13.327 13.327 14 12.5 14H3.5C2.673 14 2 13.327 2 12.5V3.5C2 2.673 2.673 2 3.5 2H12.5C13.327 2 14 2.673 14 3.5V12.5ZM12 3H4C3.448 3 3 3.448 3 4V6C3 6.552 3.448 7 4 7H12C12.552 7 13 6.552 13 6V4C13 3.448 12.552 3 12 3ZM12 6H4V4H12V6ZM12 8H9C8.448 8 8 8.448 8 9V12C8 12.552 8.448 13 9 13H12C12.552 13 13 12.552 13 12V9C13 8.448 12.552 8 12 8ZM12 12H9V9H12V12ZM7 8.5C7 8.776 6.776 9 6.5 9H3.5C3.224 9 3 8.776 3 8.5C3 8.224 3.224 8 3.5 8H6.5C6.776 8 7 8.224 7 8.5ZM7 10.5C7 10.776 6.776 11 6.5 11H3.5C3.224 11 3 10.776 3 10.5C3 10.224 3.224 10 3.5 10H6.5C6.776 10 7 10.224 7 10.5ZM7 12.5C7 12.776 6.776 13 6.5 13H3.5C3.224 13 3 12.776 3 12.5C3 12.224 3.224 12 3.5 12H6.5C6.776 12 7 12.224 7 12.5Z" />
    </svg>
  )
}

function DiffIcon() {
  return (
    <svg
      className="code-file-editor-action-svg"
      width="16"
      height="16"
      viewBox="0 0 16 16"
      xmlns="http://www.w3.org/2000/svg"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M5.5 2H2.5C1.673 2 1 2.673 1 3.5V12.5C1 13.327 1.673 14 2.5 14H5.5C6.327 14 7 13.327 7 12.5V3.5C7 2.673 6.327 2 5.5 2ZM2.5 3H5.5C5.775 3 6 3.224 6 3.5V5H2V3.5C2 3.224 2.225 3 2.5 3ZM5.5 13H2.5C2.225 13 2 12.776 2 12.5V6H6V12.5C6 12.776 5.775 13 5.5 13ZM13.5 2H10.5C9.673 2 9 2.673 9 3.5V12.5C9 13.327 9.673 14 10.5 14H13.5C14.327 14 15 13.327 15 12.5V3.5C15 2.673 14.327 2 13.5 2ZM10.5 3H13.5C13.775 3 14 3.224 14 3.5V8H10V3.5C10 3.224 10.225 3 10.5 3ZM13.5 13H10.5C10.225 13 10 12.776 10 12.5V10H14V12.5C14 12.776 13.775 13 13.5 13Z" />
    </svg>
  )
}

function MarkdownSplitPreviewIcon() {
  return (
    <svg
      className="code-file-editor-action-svg"
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M2.5 2C1.673 2 1 2.673 1 3.5V12.5C1 13.327 1.673 14 2.5 14H13.5C14.327 14 15 13.327 15 12.5V3.5C15 2.673 14.327 2 13.5 2H2.5ZM2 3.5C2 3.224 2.225 3 2.5 3H7.5V13H2.5C2.225 13 2 12.776 2 12.5V3.5ZM8.5 13V3H13.5C13.775 3 14 3.224 14 3.5V12.5C14 12.776 13.775 13 13.5 13H8.5ZM3.5 5H6V6H3.5V5ZM3.5 7H6V8H3.5V7ZM10 5H12.5V6H10V5ZM10 7H12.5V8H10V7ZM10 9H12.5V10H10V9Z" />
    </svg>
  )
}

function sourcePreviewLabel(actions: WorkspaceEditorActionState, copy: CodeCopy, open: boolean) {
  if (actions.showMarkdownPreview) return open ? copy.showMarkdownSource : copy.openMarkdownPreview
  return open ? copy.showFileSource : copy.openFilePreview
}

interface FileEditorActionsProps {
  actions: WorkspaceEditorActionState
  copy: CodeCopy
  diffOpen: boolean
  markdownSplitOpen: boolean
  openFile: OpenWorkspaceFile
  sourcePreviewOpen: boolean
  statusText: string | null
  onReload: () => void
  onSave: (overwrite?: boolean) => void
  onToggleMarkdownSplit: () => void
  onToggleSourcePreview: () => void
  onToggleDiff: () => void
}

export function FileEditorActions({
  actions,
  copy,
  diffOpen,
  markdownSplitOpen,
  openFile,
  sourcePreviewOpen,
  statusText,
  onReload,
  onSave,
  onToggleMarkdownSplit,
  onToggleSourcePreview,
  onToggleDiff,
}: FileEditorActionsProps) {
  const showSourcePreviewAction = actions.showMarkdownPreview || actions.showSourcePreview
  const previewLabel = sourcePreviewLabel(actions, copy, sourcePreviewOpen)
  const splitPreviewLabel = markdownSplitOpen ? copy.closeMarkdownSplitPreview : copy.openMarkdownSplitPreview

  return (
    <div className="code-file-editor-actions">
      {actions.showStatus && statusText && (
        <span className={`code-file-editor-status ${openFile.externalChanged ? 'warning' : ''}`}>
          {statusText}
        </span>
      )}
      {actions.showSave && (
        <button
          type="button"
          className="code-file-editor-action save"
          onClick={() => onSave(false)}
          disabled={openFile.saving}
          aria-label={copy.saveFile}
          title={copy.saveFile}
        />
      )}
      {actions.showDiff && (
        <button
          type="button"
          className={`code-file-editor-action diff ${diffOpen ? 'active' : ''}`}
          onClick={onToggleDiff}
          disabled={openFile.saving}
          aria-label={diffOpen ? copy.closeDiff : copy.openFileDiff}
          title={diffOpen ? copy.closeDiff : copy.openFileDiff}
        >
          <DiffIcon />
        </button>
      )}
      {showSourcePreviewAction && (
        <button
          type="button"
          className="code-file-editor-action source-preview"
          onClick={onToggleSourcePreview}
          disabled={openFile.saving}
          aria-label={previewLabel}
          title={previewLabel}
        >
          <MarkdownPreviewIcon previewOpen={sourcePreviewOpen} />
        </button>
      )}
      {actions.showMarkdownPreview && (
        <button
          type="button"
          className={`code-file-editor-action markdown-split ${markdownSplitOpen ? 'active' : ''}`}
          onClick={onToggleMarkdownSplit}
          disabled={openFile.saving}
          aria-label={splitPreviewLabel}
          title={splitPreviewLabel}
        >
          <MarkdownSplitPreviewIcon />
        </button>
      )}
      {actions.showReload && (
        <button
          type="button"
          className="code-file-editor-action reload"
          onClick={onReload}
          disabled={openFile.saving}
          aria-label={copy.reloadFile}
          title={copy.reloadFile}
        />
      )}
      {actions.showOverwrite && (
        <button
          type="button"
          className="code-file-editor-action overwrite"
          onClick={() => onSave(true)}
          disabled={openFile.saving}
          aria-label={copy.overwriteChangedFile}
          title={copy.overwriteChangedFile}
        />
      )}
    </div>
  )
}
