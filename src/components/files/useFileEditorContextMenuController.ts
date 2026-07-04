import { useCallback, useEffect, useState, type MutableRefObject } from 'react'
import * as monaco from 'monaco-editor'
import type { FileEditorContextAction } from './FileEditorContextMenu'

interface FileEditorContextMenuState {
  x: number
  y: number
  kind: 'gutter' | 'editor'
  lineNumber: number
}

type BlameCapability = 'unknown' | 'available' | 'unavailable'

interface UseFileEditorContextMenuControllerOptions {
  blameCapability: BlameCapability
  blameOpen: boolean
  canShowBlame: boolean
  canShowLineChanges: boolean
  editorRef: MutableRefObject<monaco.editor.IStandaloneCodeEditor | null>
  readOnly: boolean
  onCheckBlameCapability: () => Promise<BlameCapability | null>
  onClearBlameDetail: () => void
  onCloseTabContextMenu: () => void
  onOpenLineChanges: (mode: 'previous' | 'working', lineNumber: number) => Promise<void>
  onToggleBlame: () => Promise<void>
}

export function useFileEditorContextMenuController({
  blameCapability,
  blameOpen,
  canShowBlame,
  canShowLineChanges,
  editorRef,
  readOnly,
  onCheckBlameCapability,
  onClearBlameDetail,
  onCloseTabContextMenu,
  onOpenLineChanges,
  onToggleBlame,
}: UseFileEditorContextMenuControllerOptions) {
  const [editorContextMenu, setEditorContextMenu] = useState<FileEditorContextMenuState | null>(null)

  const closeEditorContextMenu = useCallback(() => {
    setEditorContextMenu(null)
  }, [])

  const openEditorContextMenu = useCallback((event: monaco.editor.IEditorMouseEvent) => {
    const targetType = event.target.type
    const gutterTypes = new Set([
      monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN,
      monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS,
      monaco.editor.MouseTargetType.GUTTER_LINE_DECORATIONS,
      monaco.editor.MouseTargetType.GUTTER_VIEW_ZONE,
    ])
    const lineNumber = event.target.position?.lineNumber ?? editorRef.current?.getPosition()?.lineNumber ?? 1
    const kind = gutterTypes.has(targetType) ? 'gutter' : 'editor'

    event.event.preventDefault()
    event.event.stopPropagation()
    onClearBlameDetail()
    onCloseTabContextMenu()
    const nextMenu: FileEditorContextMenuState = {
      x: Math.max(8, Math.min(event.event.posx, window.innerWidth - 220)),
      y: Math.max(8, Math.min(event.event.posy, window.innerHeight - 230)),
      kind,
      lineNumber,
    }
    if (kind === 'gutter' && canShowBlame && !blameOpen) {
      void onCheckBlameCapability().then(capability => {
        if (capability === null) return
        setEditorContextMenu(nextMenu)
      })
      return
    }
    setEditorContextMenu(nextMenu)
  }, [blameOpen, canShowBlame, editorRef, onCheckBlameCapability, onClearBlameDetail, onCloseTabContextMenu])

  const runEditorContextAction = useCallback(async (action: FileEditorContextAction) => {
    const editor = editorRef.current
    const menu = editorContextMenu
    closeEditorContextMenu()
    if (!editor) return

    const model = editor.getModel()
    const selection = editor.getSelection()
    if (action === 'toggle-blame') {
      if (!canShowBlame) return
      await onToggleBlame()
      return
    }
    if (action === 'line-changes-previous' || action === 'line-changes-working') {
      if (!canShowLineChanges) return
      const lineNumber = menu?.lineNumber ?? editor.getPosition()?.lineNumber ?? 1
      await onOpenLineChanges(action === 'line-changes-previous' ? 'previous' : 'working', lineNumber)
      return
    }
    if (action === 'select-all' && model) {
      editor.setSelection(model.getFullModelRange())
      editor.focus()
      return
    }
    if (!model || !selection) return

    if (action === 'copy' || action === 'cut') {
      const text = model.getValueInRange(selection)
      if (text) await navigator.clipboard?.writeText(text).catch(() => {})
      if (action === 'cut' && text && !readOnly) {
        editor.executeEdits('farming-context-menu', [{ range: selection, text: '', forceMoveMarkers: true }])
      }
      editor.focus()
      return
    }

    if (action === 'paste' && !readOnly) {
      const text = await navigator.clipboard?.readText().catch(() => '') ?? ''
      if (text) {
        editor.executeEdits('farming-context-menu', [{ range: selection, text, forceMoveMarkers: true }])
      }
      editor.focus()
    }
  }, [canShowBlame, canShowLineChanges, closeEditorContextMenu, editorContextMenu, editorRef, onOpenLineChanges, onToggleBlame, readOnly])

  const showBlameContextAction = Boolean(editorContextMenu && editorContextMenu.kind === 'gutter' && canShowBlame && (blameOpen || blameCapability === 'available'))
  const showLineChangesContextActions = Boolean(editorContextMenu && editorContextMenu.kind === 'gutter' && canShowLineChanges)

  useEffect(() => {
    const closeFloatingMenus = (event: MouseEvent) => {
      const target = event.target
      if (target instanceof Element && target.closest('.code-editor-context-menu, .code-file-tab-context-menu, .code-file-blame-detail, .code-file-inline-blame, .code-file-line-changes-panel')) {
        return
      }
      setEditorContextMenu(null)
      onCloseTabContextMenu()
    }
    const closeFloatingMenusOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setEditorContextMenu(null)
      onCloseTabContextMenu()
    }
    document.addEventListener('mousedown', closeFloatingMenus, true)
    document.addEventListener('keydown', closeFloatingMenusOnEscape, true)
    return () => {
      document.removeEventListener('mousedown', closeFloatingMenus, true)
      document.removeEventListener('keydown', closeFloatingMenusOnEscape, true)
    }
  }, [onCloseTabContextMenu])

  return {
    editorContextMenu,
    closeEditorContextMenu,
    openEditorContextMenu,
    runEditorContextAction,
    showBlameContextAction,
    showLineChangesContextActions,
  }
}
