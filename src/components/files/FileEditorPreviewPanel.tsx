import { iconForFilePath } from '@/lib/file-icons'
import { isWorkspaceSvgFile, workspaceEditorBasename as basename } from '@/lib/workspace-editor-model'
import type { OpenWorkspaceFile } from '@/lib/workspace-open-files'
import { rawWorkspaceFileUrl } from '@/lib/workspace-files'
import type { CodeCopy } from '../code/copy'

interface FileEditorPreviewPanelProps {
  openFile: OpenWorkspaceFile
  activeTabDomId: string
  copy: CodeCopy
  sourcePreviewOpen?: boolean
}

export function FileEditorPreviewPanel({
  openFile,
  activeTabDomId,
  copy,
  sourcePreviewOpen,
}: FileEditorPreviewPanelProps) {
  const filePreview = openFile.file.preview ?? null
  const sourceImagePreview = sourcePreviewOpen && isWorkspaceSvgFile(openFile.file.path)
    ? { kind: 'image' as const, mediaType: 'image/svg+xml' }
    : null
  const imagePreview = filePreview?.kind === 'image' ? filePreview : sourceImagePreview
  const binaryPreview = filePreview?.kind === 'binary' ? filePreview : null

  if (imagePreview) {
    return (
      <section
        className="code-file-preview-panel"
        data-testid="code-file-preview-panel"
        role="tabpanel"
        aria-labelledby={activeTabDomId}
        tabIndex={-1}
      >
        <div className="code-file-image-preview-frame">
          <img
            className="code-file-image-preview"
            data-testid="code-file-image-preview"
            src={rawWorkspaceFileUrl(openFile.agentId, openFile.file.path, openFile.file.sha1)}
            alt={basename(openFile.file.path)}
            draggable={false}
          />
        </div>
      </section>
    )
  }

  if (binaryPreview) {
    return (
      <section
        className="code-file-preview-panel metadata"
        data-testid="code-file-preview-panel"
        role="tabpanel"
        aria-labelledby={activeTabDomId}
        aria-label={copy.previewFor(openFile.file.path)}
        tabIndex={-1}
      >
        <img
          className="code-file-metadata-preview-icon"
          data-testid="code-file-metadata-preview-icon"
          src={iconForFilePath(openFile.file.path)}
          alt=""
          aria-hidden="true"
          draggable={false}
        />
      </section>
    )
  }

  return null
}
