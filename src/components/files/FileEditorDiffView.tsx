import { useEffect, useMemo, useRef } from 'react'
import * as monaco from 'monaco-editor'
import {
  applyWorkspaceEditorMonacoTheme,
  configureWorkspaceEditorMonacoEnvironment,
  workspaceEditorLanguageForPath,
  workspaceEditorMonacoThemeForAppearance,
} from '@/lib/workspace-editor-monaco'
import type { OpenWorkspaceFile } from '@/lib/workspace-open-files'
import type { CodeCopy } from '../code/copy'
import type { FileEditorDiffState } from './useFileEditorDiffController'

interface FileEditorDiffViewProps {
  openFile: OpenWorkspaceFile
  diffState: FileEditorDiffState
  copy: CodeCopy
  onClose: () => void
}

function diffStatusText(diffState: FileEditorDiffState, copy: CodeCopy) {
  if (diffState.loading) return copy.loadingDiff
  if (diffState.error) return diffState.error
  const diff = diffState.diff
  if (!diff) return ''
  if (!diff.isGitRepo) return copy.notGitRepository
  if (diff.binary) return copy.binaryDiffUnavailable
  if (diff.truncated) return copy.diffTooLarge
  if (!diff.patch.trim()) return copy.noFileDiff
  if (typeof diff.originalContent !== 'string' || typeof diff.modifiedContent !== 'string') {
    return copy.diffUnavailable
  }
  return ''
}

function canShowDiffEditor(diffState: FileEditorDiffState) {
  const diff = diffState.diff
  return Boolean(
    diff
      && diff.isGitRepo
      && !diff.binary
      && !diff.truncated
      && diff.patch.trim()
      && typeof diff.originalContent === 'string'
      && typeof diff.modifiedContent === 'string'
  )
}

function diffModelUri(openFile: OpenWorkspaceFile, side: 'original' | 'modified') {
  return monaco.Uri.from({
    scheme: 'farming-diff',
    authority: openFile.agentId.replace(/[^a-zA-Z0-9_-]+/g, '-') || 'agent',
    path: `/${openFile.file.path.replace(/^\/+/, '')}`,
    query: side,
  })
}

function createDiffTextModel(openFile: OpenWorkspaceFile, side: 'original' | 'modified', value: string, languageId: string) {
  const uri = diffModelUri(openFile, side)
  monaco.editor.getModel(uri)?.dispose()
  return monaco.editor.createModel(value, languageId, uri)
}

export function FileEditorDiffView({
  openFile,
  diffState,
  copy,
  onClose,
}: FileEditorDiffViewProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const diffEditorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null)
  const originalModelRef = useRef<monaco.editor.ITextModel | null>(null)
  const modifiedModelRef = useRef<monaco.editor.ITextModel | null>(null)
  const showDiffEditor = canShowDiffEditor(diffState)
  const statusText = useMemo(() => diffStatusText(diffState, copy), [copy, diffState])

  useEffect(() => {
    if (!showDiffEditor) return undefined
    const host = hostRef.current
    if (!host) return undefined

    configureWorkspaceEditorMonacoEnvironment()
    applyWorkspaceEditorMonacoTheme()
    const diffEditor = monaco.editor.createDiffEditor(host, {
      theme: workspaceEditorMonacoThemeForAppearance(),
      automaticLayout: false,
      renderSideBySide: true,
      originalEditable: false,
      readOnly: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      fixedOverflowWidgets: true,
      renderOverviewRuler: true,
      enableSplitViewResizing: true,
      ignoreTrimWhitespace: false,
      glyphMargin: true,
      lineNumbersMinChars: 4,
      unicodeHighlight: {
        ambiguousCharacters: false,
        invisibleCharacters: true,
        nonBasicASCII: false,
      },
    })
    diffEditorRef.current = diffEditor
    const resizeObserver = new ResizeObserver(() => diffEditor.layout())
    resizeObserver.observe(host)
    const appearanceObserver = new MutationObserver(() => applyWorkspaceEditorMonacoTheme(diffEditor))
    appearanceObserver.observe(document.body, {
      attributes: true,
      attributeFilter: ['data-appearance'],
    })
    window.requestAnimationFrame(() => diffEditor.layout())

    return () => {
      resizeObserver.disconnect()
      appearanceObserver.disconnect()
      diffEditor.dispose()
      originalModelRef.current?.dispose()
      modifiedModelRef.current?.dispose()
      originalModelRef.current = null
      modifiedModelRef.current = null
      diffEditorRef.current = null
    }
  }, [showDiffEditor])

  useEffect(() => {
    if (!showDiffEditor || !diffState.diff) return
    const diffEditor = diffEditorRef.current
    if (!diffEditor) return
    originalModelRef.current?.dispose()
    modifiedModelRef.current?.dispose()
    const languageId = workspaceEditorLanguageForPath(openFile.file.path, diffState.diff.modifiedContent)
    const originalModel = createDiffTextModel(openFile, 'original', diffState.diff.originalContent ?? '', languageId)
    const modifiedModel = createDiffTextModel(openFile, 'modified', diffState.diff.modifiedContent ?? '', languageId)
    originalModelRef.current = originalModel
    modifiedModelRef.current = modifiedModel
    diffEditor.setModel({
      original: originalModel,
      modified: modifiedModel,
    })
    window.requestAnimationFrame(() => diffEditor.layout())
  }, [diffState.diff, openFile, showDiffEditor])

  return (
    <section className="code-file-diff-view" data-testid="code-file-diff-view" aria-label={copy.fileDiff}>
      <header className="code-file-diff-header">
        <div className="code-file-diff-title">
          <strong>{copy.fileDiff}</strong>
          <span>{openFile.file.path}</span>
        </div>
        <button
          type="button"
          className="code-file-diff-close"
          aria-label={copy.closeDiff}
          onClick={onClose}
        />
      </header>
      {statusText && (
        <div className={`code-file-diff-state ${diffState.error ? 'error' : ''}`}>
          {statusText}
        </div>
      )}
      <div
        ref={hostRef}
        className={`code-file-diff-monaco ${showDiffEditor ? '' : 'hidden'}`}
        data-testid="code-file-diff-monaco"
      />
    </section>
  )
}
