import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { iconForFilePath } from '@/lib/file-icons'
import {
  isWorkspaceHtmlFile,
  isWorkspaceSvgFile,
  workspaceEditorBasename as basename,
  workspaceEditorModelKey,
} from '@/lib/workspace-editor-model'
import type { OpenWorkspaceFile } from '@/lib/workspace-open-files'
import { rawWorkspaceFileUrl } from '@/lib/workspace-files'
import type { CodeCopy } from '../code/copy'
import { FileEditorHtmlPreview } from './FileEditorHtmlPreview'

interface FileEditorPreviewPanelProps {
  openFile: OpenWorkspaceFile
  activeTabDomId: string
  copy: CodeCopy
  sourcePreviewOpen?: boolean
  previewRefreshRevision?: number
  visible: boolean
}

interface RetainedPdfPreview {
  activeTabDomId: string
  key: string
  src: string
  title: string
}

const MAX_RETAINED_PDF_PREVIEWS = 6

export function FileEditorPreviewPanel({
  openFile,
  activeTabDomId,
  copy,
  sourcePreviewOpen,
  previewRefreshRevision = 0,
  visible,
}: FileEditorPreviewPanelProps) {
  const filePreview = openFile.file.preview ?? null
  const sourceImagePreview = sourcePreviewOpen && isWorkspaceSvgFile(openFile.file.path)
    ? { kind: 'image' as const, mediaType: 'image/svg+xml' }
    : null
  const imagePreview = filePreview?.kind === 'image' ? filePreview : sourceImagePreview
  const pdfPreview = filePreview?.kind === 'pdf' ? filePreview : null
  const binaryPreview = filePreview?.kind === 'binary' ? filePreview : null
  const activePdf = useMemo(
    () => visible && pdfPreview
      ? {
          activeTabDomId,
          key: workspaceEditorModelKey(openFile),
          src: `${rawWorkspaceFileUrl(openFile.agentId, openFile.file.path, openFile.file.sha1, { exactExternal: openFile.exactExternal })}&previewRefresh=${previewRefreshRevision}`,
          title: copy.previewFor(openFile.file.path),
        }
      : null,
    [activeTabDomId, copy, openFile, pdfPreview, previewRefreshRevision, visible],
  )
  const [retainedPdfs, setRetainedPdfs] = useState<RetainedPdfPreview[]>([])

  useEffect(() => {
    if (!activePdf) return
    setRetainedPdfs(current => [
      ...current.filter(entry => entry.key !== activePdf.key),
      activePdf,
    ].slice(-MAX_RETAINED_PDF_PREVIEWS))
  }, [activePdf])

  const pdfEntries = activePdf
    ? [
        ...retainedPdfs.filter(entry => entry.key !== activePdf.key),
        activePdf,
      ].slice(-MAX_RETAINED_PDF_PREVIEWS)
    : retainedPdfs
  let activePreview: ReactNode = null

  if (visible && sourcePreviewOpen && isWorkspaceHtmlFile(openFile.file.path)) {
    activePreview = (
      <FileEditorHtmlPreview
        activeTabDomId={activeTabDomId}
        copy={copy}
        openFile={openFile}
        previewRefreshRevision={previewRefreshRevision}
      />
    )
  } else if (visible && imagePreview) {
    activePreview = (
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
            src={`${rawWorkspaceFileUrl(openFile.agentId, openFile.file.path, openFile.file.sha1, { exactExternal: openFile.exactExternal })}&previewRefresh=${previewRefreshRevision}`}
            alt={basename(openFile.file.path)}
            draggable={false}
          />
        </div>
      </section>
    )
  } else if (visible && binaryPreview) {
    activePreview = (
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

  return (
    <>
      {activePreview}
      {pdfEntries.map(entry => {
        const active = activePdf?.key === entry.key
        return (
          <section
            key={entry.key}
            className={`code-file-preview-panel cached-pdf ${active ? '' : 'hidden'}`.trim()}
            data-testid={active ? 'code-file-preview-panel' : undefined}
            role={active ? 'tabpanel' : undefined}
            aria-labelledby={active ? entry.activeTabDomId : undefined}
            aria-hidden={active ? undefined : true}
            tabIndex={active ? -1 : undefined}
          >
            <iframe
              className="code-file-pdf-preview"
              data-testid={active ? 'code-file-pdf-preview' : undefined}
              src={entry.src}
              title={entry.title}
            />
          </section>
        )
      })}
    </>
  )
}
