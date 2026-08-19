import { useEffect, useMemo, useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import * as monaco from 'monaco-editor'
import {
  applyWorkspaceEditorMonacoTheme,
  cancelWorkspaceEditorScheduledLayout,
  configureWorkspaceEditorMonacoEnvironment,
  updateWorkspaceEditorContentFontSize,
  workspaceEditorFontOptions,
  workspaceEditorLanguageForPath,
  workspaceEditorMonacoThemeForAppearance,
  workspaceEditorScrollbarOptions,
} from '@/lib/workspace-editor-monaco'
import { workspaceFileResourceKey } from '@/lib/workspace-working-copy'
import type { OpenWorkspaceFile } from '@/lib/workspace-open-files'
import { isCompactViewport } from '@/lib/responsive-mode'
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
  const resourceKey = workspaceFileResourceKey(openFile.file.path, openFile.workspaceRoot)
  return monaco.Uri.from({
    scheme: 'farming-diff',
    path: resourceKey.startsWith('/') ? resourceKey : `/${resourceKey}`,
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
  const viewRef = useRef<HTMLElement>(null)
  const diffEditorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null)
  const originalModelRef = useRef<monaco.editor.ITextModel | null>(null)
  const modifiedModelRef = useRef<monaco.editor.ITextModel | null>(null)
  const showDiffEditor = canShowDiffEditor(diffState)
  const statusText = useMemo(() => diffStatusText(diffState, copy), [copy, diffState])

  useEffect(() => {
    viewRef.current?.focus({ preventScroll: true })
  }, [])

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    onClose()
  }

  useEffect(() => {
    if (!showDiffEditor) return undefined
    const host = hostRef.current
    if (!host) return undefined

    configureWorkspaceEditorMonacoEnvironment()
    applyWorkspaceEditorMonacoTheme()
    const diffEditor = monaco.editor.createDiffEditor(host, {
      theme: workspaceEditorMonacoThemeForAppearance(),
      automaticLayout: false,
      // A side-by-side diff leaves two line-number gutters on a phone. Use
      // Monaco's inline diff layout there so the code keeps one readable
      // column and the user can scroll it vertically.
      renderSideBySide: !isCompactViewport(),
      originalEditable: false,
      readOnly: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      ...workspaceEditorFontOptions(),
      ...workspaceEditorScrollbarOptions(),
      fixedOverflowWidgets: true,
      renderOverviewRuler: true,
      enableSplitViewResizing: !isCompactViewport(),
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
    const appearanceObserver = new MutationObserver(records => {
      if (records.some(record => record.attributeName === 'data-appearance')) {
        applyWorkspaceEditorMonacoTheme(diffEditor)
      }
      if (records.some(record => record.attributeName === 'data-code-content-font-size')) {
        updateWorkspaceEditorContentFontSize(diffEditor)
      }
    })
    appearanceObserver.observe(document.body, {
      attributes: true,
      attributeFilter: ['data-appearance', 'data-code-content-font-size'],
    })
    const initialLayoutFrame = window.requestAnimationFrame(() => diffEditor.layout())

    return () => {
      window.cancelAnimationFrame(initialLayoutFrame)
      resizeObserver.disconnect()
      appearanceObserver.disconnect()
      cancelWorkspaceEditorScheduledLayout(diffEditor)
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
    const layoutFrame = window.requestAnimationFrame(() => diffEditor.layout())
    return () => window.cancelAnimationFrame(layoutFrame)
  }, [diffState.diff, openFile, showDiffEditor])

  return (
    <section
      ref={viewRef}
      className="code-file-diff-view"
      data-testid="code-file-diff-view"
      aria-label={copy.fileDiff}
      tabIndex={-1}
      onKeyDownCapture={handleKeyDown}
    >
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
