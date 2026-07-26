import { useEffect, useMemo, useState } from 'react'
import {
  buildWorkspaceHtmlPreviewDocument,
  workspaceHtmlPreviewRefreshDelay,
} from '@/lib/workspace-html-preview'
import type { OpenWorkspaceFile } from '@/lib/workspace-open-files'
import {
  createWorkspaceHtmlPreview,
  deleteWorkspaceHtmlPreview,
  workspaceHtmlPreviewUrl,
} from '@/lib/workspace-files'
import type { CodeCopy } from '../code/copy'

interface FileEditorHtmlPreviewProps {
  activeTabDomId: string
  copy: CodeCopy
  openFile: OpenWorkspaceFile
}

export function FileEditorHtmlPreview({ activeTabDomId, copy, openFile }: FileEditorHtmlPreviewProps) {
  const [previewId, setPreviewId] = useState('')
  const [sessionGeneration, setSessionGeneration] = useState(0)
  const [error, setError] = useState('')
  const [previewSource, setPreviewSource] = useState(openFile.draft)

  useEffect(() => {
    const timeout = window.setTimeout(() => setPreviewSource(openFile.draft), 200)
    return () => window.clearTimeout(timeout)
  }, [openFile.draft])

  useEffect(() => {
    let cancelled = false
    let ownedPreviewId = ''
    let refreshTimeout = 0
    setPreviewId('')
    setError('')

    void createWorkspaceHtmlPreview(openFile.agentId, openFile.file.path, {
      exactExternal: openFile.exactExternal,
    }).then(preview => {
      if (cancelled) {
        void deleteWorkspaceHtmlPreview(preview.id)
        return
      }
      ownedPreviewId = preview.id
      setPreviewId(preview.id)
      refreshTimeout = window.setTimeout(
        () => setSessionGeneration(generation => generation + 1),
        workspaceHtmlPreviewRefreshDelay(preview.expiresAt),
      )
    }).catch(reason => {
      if (cancelled) return
      setError(reason instanceof Error ? reason.message : String(reason || 'HTML preview failed'))
    })

    return () => {
      cancelled = true
      window.clearTimeout(refreshTimeout)
      if (ownedPreviewId) void deleteWorkspaceHtmlPreview(ownedPreviewId)
    }
  }, [openFile.agentId, openFile.exactExternal, openFile.file.path, sessionGeneration])

  const previewDocument = useMemo(() => {
    if (!previewId) return ''
    const baseUrl = new URL(workspaceHtmlPreviewUrl(previewId, 'base'), window.location.href).toString()
    const rootUrl = new URL(workspaceHtmlPreviewUrl(previewId, 'root'), window.location.href).toString()
    return buildWorkspaceHtmlPreviewDocument(
      previewSource,
      baseUrl,
      rootUrl,
    )
  }, [previewId, previewSource])

  return (
    <section
      className="code-file-preview-panel html"
      data-testid="code-file-html-preview-panel"
      role="tabpanel"
      aria-labelledby={activeTabDomId}
      tabIndex={-1}
    >
      {error ? (
        <div className="code-file-diff-state error">{error}</div>
      ) : previewId ? (
        <iframe
          className="code-file-html-preview"
          data-testid="code-file-html-preview"
          sandbox=""
          referrerPolicy="no-referrer"
          srcDoc={previewDocument}
          title={copy.previewFor(openFile.file.path)}
        />
      ) : (
        <div className="code-file-diff-state">{copy.loading}</div>
      )}
    </section>
  )
}
