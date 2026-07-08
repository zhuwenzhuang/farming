import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'
import * as monaco from 'monaco-editor'
import {
  workspaceEditorCursorSelection,
  workspaceEditorModelContentVersion as modelContentVersion,
  workspaceEditorModelKey as openFileKey,
} from '@/lib/workspace-editor-model'
import {
  applyWorkspaceEditorMonacoTheme,
  configureWorkspaceEditorMonacoEnvironment,
  disposeWorkspaceEditorModels,
  nativeWorkspaceEditorContextMenuEvent,
  pruneWorkspaceEditorModelState,
  registerWorkspaceEditorCommands,
  updateWorkspaceEditorResponsiveOptions,
  workspaceEditorCreateOptions,
  workspaceEditorLanguageForPath,
  workspaceEditorModelForOpenFile,
  workspaceEditorViewportMedia,
} from '@/lib/workspace-editor-monaco'
import type { OpenWorkspaceFile } from '@/lib/workspace-open-files'
import type { WorkspaceNavigationFileInput } from '@/lib/workspace-navigation-history'
import { useFileEditorTestBridge } from './useFileEditorTestBridge'

interface UseFileEditorMonacoControllerOptions {
  openFile: OpenWorkspaceFile
  openFiles: OpenWorkspaceFile[]
  readOnly: boolean
  wordWrapEnabled: boolean
  editorLabel: string
  onChangeDraft: (draft: string) => void
  onFocusFilesSearch: (agentId: string) => void
  onRecordNavigationCursor?: (input: WorkspaceNavigationFileInput) => void
  onSaveShortcut: () => void
  onOpenContextMenuRef: MutableRefObject<(event: monaco.editor.IEditorMouseEvent) => void>
}

export function useFileEditorMonacoController({
  openFile,
  openFiles,
  readOnly,
  wordWrapEnabled,
  editorLabel,
  onChangeDraft,
  onFocusFilesSearch,
  onRecordNavigationCursor,
  onSaveShortcut,
  onOpenContextMenuRef,
}: UseFileEditorMonacoControllerOptions) {
  const editorHostRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const editorViewStatesRef = useRef(new Map<string, monaco.editor.ICodeEditorViewState | null>())
  const activeEditorModelKeyRef = useRef<string | null>(null)
  const syncedModelVersionRef = useRef(new Map<string, string>())
  const changeSubscriptionRef = useRef<monaco.IDisposable | null>(null)
  const cursorSubscriptionRef = useRef<monaco.IDisposable | null>(null)
  const contextMenuSubscriptionRef = useRef<monaco.IDisposable | null>(null)
  const resizeObserverRef = useRef<ResizeObserver | null>(null)
  const onChangeDraftRef = useRef(onChangeDraft)
  const onFocusFilesSearchRef = useRef(onFocusFilesSearch)
  const onRecordNavigationCursorRef = useRef(onRecordNavigationCursor)
  const onSaveShortcutRef = useRef(onSaveShortcut)
  const openFileAgentIdRef = useRef(openFile.agentId)
  const openFilePathRef = useRef(openFile.file.path)
  const wordWrapEnabledRef = useRef(wordWrapEnabled)
  const editorLabelRef = useRef(editorLabel)
  const lastCursorRequestRef = useRef<number | null>(null)
  const suppressEditorChangeRef = useRef(0)
  const suppressNavigationCursorRef = useRef(0)
  const [cursorPosition, setCursorPosition] = useState({ lineNumber: 1, column: 1 })

  onChangeDraftRef.current = onChangeDraft
  onFocusFilesSearchRef.current = onFocusFilesSearch
  onRecordNavigationCursorRef.current = onRecordNavigationCursor
  onSaveShortcutRef.current = onSaveShortcut
  openFileAgentIdRef.current = openFile.agentId
  openFilePathRef.current = openFile.file.path
  wordWrapEnabledRef.current = wordWrapEnabled
  editorLabelRef.current = editorLabel

  const updateCursorPosition = useCallback((editor: monaco.editor.IStandaloneCodeEditor | null) => {
    const position = editor?.getPosition()
    if (!position) return
    setCursorPosition(current => (
      current.lineNumber === position.lineNumber && current.column === position.column
        ? current
        : { lineNumber: position.lineNumber, column: position.column }
    ))
  }, [])

  const focusEditor = useCallback(() => {
    const focusCurrentEditor = () => {
      const editor = editorRef.current
      if (!editor) return
      editor.focus()
    }
    focusCurrentEditor()
    window.requestAnimationFrame(focusCurrentEditor)
  }, [])

  const revealLine = useCallback((lineNumber: number, options: { focusEditor?: boolean } = {}) => {
    const editor = editorRef.current
    if (!editor) return
    editor.setPosition({ lineNumber, column: 1 })
    editor.revealLineInCenter(lineNumber)
    if (options.focusEditor !== false) editor.focus()
  }, [])

  useFileEditorTestBridge({
    editorRef,
    onFocusEditor: focusEditor,
  })

  useEffect(() => {
    const host = editorHostRef.current
    if (!host) return undefined

    configureWorkspaceEditorMonacoEnvironment()
    applyWorkspaceEditorMonacoTheme()
    const editor = monaco.editor.create(host, workspaceEditorCreateOptions({
      value: openFile.draft,
      language: workspaceEditorLanguageForPath(openFile.file.path, openFile.draft),
      ariaLabel: editorLabelRef.current,
      wordWrapEnabled: wordWrapEnabledRef.current,
    }))
    applyWorkspaceEditorMonacoTheme(editor)

    const applyResponsiveEditorOptions = () => updateWorkspaceEditorResponsiveOptions(editor, wordWrapEnabledRef.current)
    const viewportMedia = workspaceEditorViewportMedia()
    const handleViewportMediaChange = () => applyResponsiveEditorOptions()
    if (typeof viewportMedia.addEventListener === 'function') {
      viewportMedia.addEventListener('change', handleViewportMediaChange)
    } else {
      viewportMedia.addListener(handleViewportMediaChange)
    }
    applyResponsiveEditorOptions()

    editorRef.current = editor
    changeSubscriptionRef.current = editor.onDidChangeModelContent(() => {
      if (suppressEditorChangeRef.current > 0) return
      onChangeDraftRef.current(editor.getValue())
    })
    cursorSubscriptionRef.current = editor.onDidChangeCursorPosition(event => {
      updateCursorPosition(editor)
      if (suppressNavigationCursorRef.current > 0) return
      if (event.reason !== monaco.editor.CursorChangeReason.Explicit) return
      if (event.source === 'api') return

      const selection = editor.getSelection()
      onRecordNavigationCursorRef.current?.({
        agentId: openFileAgentIdRef.current,
        filePath: openFilePathRef.current,
        lineNumber: event.position.lineNumber,
        column: event.position.column,
        endColumn: selection?.endColumn,
      })
    })
    registerWorkspaceEditorCommands(editor, {
      getAgentId: () => openFileAgentIdRef.current,
      onFocusFilesSearch: agentId => onFocusFilesSearchRef.current(agentId),
      onSaveShortcut: () => onSaveShortcutRef.current(),
    })
    contextMenuSubscriptionRef.current = editor.onContextMenu(event => onOpenContextMenuRef.current(event))
    const handleNativeEditorContextMenu = (event: MouseEvent) => {
      const editorEvent = nativeWorkspaceEditorContextMenuEvent(editor, event)
      if (editorEvent) onOpenContextMenuRef.current(editorEvent)
    }
    host.addEventListener('contextmenu', handleNativeEditorContextMenu, true)
    resizeObserverRef.current = new ResizeObserver(() => editor.layout())
    resizeObserverRef.current.observe(host)
    const appearanceObserver = new MutationObserver(() => applyWorkspaceEditorMonacoTheme(editor))
    appearanceObserver.observe(document.body, {
      attributes: true,
      attributeFilter: ['data-appearance'],
    })

    return () => {
      const activeModelId = activeEditorModelKeyRef.current
      if (activeModelId) {
        editorViewStatesRef.current.set(activeModelId, editor.saveViewState())
      }
      resizeObserverRef.current?.disconnect()
      resizeObserverRef.current = null
      appearanceObserver.disconnect()
      contextMenuSubscriptionRef.current?.dispose()
      contextMenuSubscriptionRef.current = null
      host.removeEventListener('contextmenu', handleNativeEditorContextMenu, true)
      if (typeof viewportMedia.removeEventListener === 'function') {
        viewportMedia.removeEventListener('change', handleViewportMediaChange)
      } else {
        viewportMedia.removeListener(handleViewportMediaChange)
      }
      cursorSubscriptionRef.current?.dispose()
      cursorSubscriptionRef.current = null
      changeSubscriptionRef.current?.dispose()
      changeSubscriptionRef.current = null
      editor.dispose()
      disposeWorkspaceEditorModels()
      editorViewStatesRef.current.clear()
      editorRef.current = null
      activeEditorModelKeyRef.current = null
    }
  }, [onOpenContextMenuRef, updateCursorPosition])

  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return

    const nextModelKey = openFileKey(openFile)
    const nextModelVersion = modelContentVersion(openFile)
    const previousModelId = activeEditorModelKeyRef.current
    if (previousModelId && previousModelId !== nextModelKey) {
      editorViewStatesRef.current.set(previousModelId, editor.saveViewState())
    }

    const model = workspaceEditorModelForOpenFile(openFile)
    if (editor.getModel() !== model) {
      editor.setModel(model)
    }
    const previousSyncedVersion = syncedModelVersionRef.current.get(nextModelKey)
    const shouldApplyExternalContent = previousModelId !== nextModelKey || previousSyncedVersion !== nextModelVersion
    if (shouldApplyExternalContent && model.getValue() !== openFile.draft) {
      suppressEditorChangeRef.current += 1
      try {
        model.setValue(openFile.draft)
      } finally {
        suppressEditorChangeRef.current -= 1
      }
    }
    syncedModelVersionRef.current.set(nextModelKey, nextModelVersion)
    if (previousModelId !== nextModelKey) {
      const viewState = editorViewStatesRef.current.get(nextModelKey)
      if (viewState) {
        editor.restoreViewState(viewState)
      }
      activeEditorModelKeyRef.current = nextModelKey
    }
    updateCursorPosition(editor)
  }, [
    openFile,
    updateCursorPosition,
  ])

  useEffect(() => {
    const liveFiles = [...openFiles, openFile]
    pruneWorkspaceEditorModelState(liveFiles, editorViewStatesRef.current)
  }, [openFile, openFiles])

  useEffect(() => {
    const editor = editorRef.current
    const cursor = openFile.cursor
    if (!editor || !cursor || lastCursorRequestRef.current === cursor.requestId) return

    const model = editor.getModel()
    const selection = workspaceEditorCursorSelection(cursor, {
      lineCount: model?.getLineCount() ?? 1,
      getLineMaxColumn: lineNumber => model?.getLineMaxColumn(lineNumber) ?? 1,
    })

    suppressNavigationCursorRef.current += 1
    try {
      editor.setSelection(selection)
      editor.revealLineInCenter(selection.startLineNumber)
      editor.focus()
    } finally {
      window.setTimeout(() => {
        suppressNavigationCursorRef.current = Math.max(0, suppressNavigationCursorRef.current - 1)
      }, 120)
    }
    lastCursorRequestRef.current = cursor.requestId
    setCursorPosition({
      lineNumber: selection.startLineNumber,
      column: selection.startColumn,
    })
  }, [openFile.cursor, openFile.file.path])

  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    editor.updateOptions({
      readOnly,
      domReadOnly: readOnly,
    })
  }, [readOnly])

  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    updateWorkspaceEditorResponsiveOptions(editor, wordWrapEnabled)
  }, [wordWrapEnabled])

  return {
    editorHostRef,
    editorRef,
    cursorPosition,
    focusEditor,
    revealLine,
  }
}
