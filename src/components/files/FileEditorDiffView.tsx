import { useEffect, useMemo, useRef, useState } from 'react'
import { useInteractionLayer } from '@/hooks/useInteractionLayer'
import { ChevronDownGlyph, ChevronUpGlyph } from '@/components/IconGlyphs'
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
import { FileEditorDiffBlame } from './FileEditorDiffBlame'

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

function diffModelUri(filePath: string, workspaceRoot: string | undefined, side: 'original' | 'modified') {
  const resourceKey = workspaceFileResourceKey(filePath, workspaceRoot)
  return monaco.Uri.from({
    scheme: 'farming-diff',
    path: resourceKey.startsWith('/') ? resourceKey : `/${resourceKey}`,
    query: side,
  })
}

function createDiffTextModel(filePath: string, workspaceRoot: string | undefined, side: 'original' | 'modified', value: string, languageId: string) {
  const uri = diffModelUri(filePath, workspaceRoot, side)
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
  const navigateRef = useRef<((direction: 'previous' | 'next') => void) | null>(null)
  const [navigation, setNavigation] = useState({ current: 0, total: 0 })
  const [editors, setEditors] = useState<{
    original: monaco.editor.IStandaloneCodeEditor
    modified: monaco.editor.IStandaloneCodeEditor
    snapshot: FileEditorDiffState['diff']
    modelKey: string
  } | null>(null)
  const showDiffEditor = canShowDiffEditor(diffState)
  const filePath = openFile.file.path
  const workspaceRoot = openFile.workspaceRoot
  const statusText = useMemo(() => diffStatusText(diffState, copy), [copy, diffState])

  useEffect(() => {
    viewRef.current?.focus({ preventScroll: true })
  }, [])

  useInteractionLayer({
    enabled: true,
    elements: () => [viewRef.current],
    dismissOnPointerOutside: false,
    onDismiss: onClose,
  })

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
      contextmenu: false,
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
      setEditors(null)
    }
  }, [showDiffEditor])

  useEffect(() => {
    if (!showDiffEditor || !diffState.diff) return
    const diffEditor = diffEditorRef.current
    if (!diffEditor) return
    originalModelRef.current?.dispose()
    modifiedModelRef.current?.dispose()
    const languageId = workspaceEditorLanguageForPath(filePath, diffState.diff.modifiedContent)
    const originalModel = createDiffTextModel(filePath, workspaceRoot, 'original', diffState.diff.originalContent ?? '', languageId)
    const modifiedModel = createDiffTextModel(filePath, workspaceRoot, 'modified', diffState.diff.modifiedContent ?? '', languageId)
    originalModelRef.current = originalModel
    modifiedModelRef.current = modifiedModel
    const original = diffEditor.getOriginalEditor()
    const modified = diffEditor.getModifiedEditor()
    let changes: monaco.editor.ILineChange[] = []
    let current = -1
    let revealPending = true
    let navigating = false
    setNavigation({ current: 0, total: 0 })
    // Empty ranges use the preceding line in Monaco's public diff API.
    const startLine = (change: monaco.editor.ILineChange, side: 'original' | 'modified') =>
      change[`${side}StartLineNumber`] + (change[`${side}EndLineNumber`] === 0 ? 1 : 0)
    const publish = () => setNavigation({ current: current + 1, total: changes.length })
    const reveal = (index: number) => {
      const change = changes[index]
      if (!change) return
      navigating = true
      current = index
      const line = Math.min(modifiedModel.getLineCount(), startLine(change, 'modified'))
      modified.setPosition({ lineNumber: line, column: 1 })
      modified.revealLineInCenter(line, monaco.editor.ScrollType.Immediate)
      // In split mode a deletion may be taller than its empty modified range.
      if (change.modifiedEndLineNumber === 0 && !isCompactViewport()) {
        original.revealLineInCenter(change.originalStartLineNumber, monaco.editor.ScrollType.Immediate)
      }
      navigating = false
      publish()
    }
    const followCursor = (side: 'original' | 'modified', line: number) => {
      if (navigating) return
      current = -1
      for (const [index, change] of changes.entries()) {
        if (startLine(change, side) <= line) current = index
      }
      publish()
    }
    const updateDiff = () => {
      const computed = diffEditor.getLineChanges()
      if (!computed) return
      changes = computed
      if (revealPending && changes.length) {
        revealPending = false
        diffEditor.layout()
        reveal(0)
      } else {
        followCursor('modified', modified.getPosition()?.lineNumber ?? 1)
      }
    }
    navigateRef.current = direction => {
      if (!changes.length) return
      revealPending = false
      const target = direction === 'next' ? current + 1 : current < 0 ? changes.length - 1 : current - 1
      reveal((target + changes.length) % changes.length)
    }
    const subscriptions = [
      diffEditor.onDidUpdateDiff(updateDiff),
      original.onDidChangeCursorPosition(event => followCursor('original', event.position.lineNumber)),
      modified.onDidChangeCursorPosition(event => followCursor('modified', event.position.lineNumber)),
    ]
    const host = hostRef.current
    const cancelReveal = () => { revealPending = false }
    for (const event of ['pointerdown', 'wheel', 'keydown']) host?.addEventListener(event, cancelReveal, { passive: true })
    diffEditor.setModel({
      original: originalModel,
      modified: modifiedModel,
    })
    setEditors({
      original: diffEditor.getOriginalEditor(), modified: diffEditor.getModifiedEditor(),
      snapshot: diffState.diff, modelKey: originalModel.id,
    })
    const layoutFrame = window.requestAnimationFrame(() => diffEditor.layout())
    return () => {
      window.cancelAnimationFrame(layoutFrame)
      navigateRef.current = null
      for (const subscription of subscriptions) subscription.dispose()
      for (const event of ['pointerdown', 'wheel', 'keydown']) host?.removeEventListener(event, cancelReveal)
    }
  }, [diffState.diff, filePath, workspaceRoot, showDiffEditor])

  return (
    <section
      ref={viewRef}
      className="code-file-diff-view"
      data-testid="code-file-diff-view"
      aria-label={copy.fileDiff}
      tabIndex={-1}
    >
      <header className="code-file-diff-header">
        <div className="code-file-diff-title">
          <strong>{copy.fileDiff}</strong>
          <span>{openFile.file.path}</span>
        </div>
        <div className="code-file-diff-navigation code-content-toolbar" role="group" aria-label={copy.diffNavigation}>
          <span role="status" aria-label={copy.diffNavigation}>{showDiffEditor ? `${navigation.current} / ${navigation.total}` : '0 / 0'}</span>
          <button type="button" aria-label={copy.previousDiffChange} title={copy.previousDiffChange}
            disabled={!showDiffEditor || navigation.total === 0} onClick={() => navigateRef.current?.('previous')}><ChevronUpGlyph /></button>
          <button type="button" aria-label={copy.nextDiffChange} title={copy.nextDiffChange}
            disabled={!showDiffEditor || navigation.total === 0} onClick={() => navigateRef.current?.('next')}><ChevronDownGlyph /></button>
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
      {showDiffEditor && editors && diffState.diff && editors.snapshot === diffState.diff && (['original', 'modified'] as const).map(side => {
        const diff = diffState.diff!
        const content = (side === 'original' ? diff.originalContent : diff.modifiedContent) ?? ''
        const revision = side === 'original' ? diff.originalRevision : undefined
        const filePath = side === 'original' ? diff.originalPath ?? openFile.file.path : openFile.file.path
        return <FileEditorDiffBlame
          key={`${side}:${editors.modelKey}`}
          openFile={{ ...openFile, dirty: false, file: { ...openFile.file, path: filePath } }}
          editor={editors[side]}
          content={content}
          revision={revision}
          disabled={Boolean(diff.untracked || (side === 'original' ? !revision : diff.deleted))}
          copy={copy}
        />
      })}
    </section>
  )
}
