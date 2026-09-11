import { useCallback, useLayoutEffect, useRef, useState, type MutableRefObject, type MouseEvent as ReactMouseEvent } from 'react'
import * as monaco from 'monaco-editor'
import { RequestOwnershipFence } from '@/lib/request-ownership'
import { writeClipboardText } from '@/lib/clipboard'
import type { FileEditorContextAction } from './FileEditorContextMenu'

interface FileEditorContextMenuState {
  scope: string
  x: number
  y: number
  kind: 'gutter' | 'editor'
  lineNumber: number
  focusFirstItem: boolean
}

function isKeyboardContextMenuEvent(event: MouseEvent) {
  return event.button === 0 && !('pointerType' in event)
}

type BlameCapability = 'unknown' | 'available' | 'unavailable'

interface UseFileEditorContextMenuControllerOptions {
  scope: string
  active: boolean
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
  languageServerAvailable: boolean
  onRunLanguageServerAction: (action: FileEditorContextAction) => Promise<void>
}

export function useFileEditorContextMenuController({
  scope,
  active,
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
  languageServerAvailable,
  onRunLanguageServerAction,
}: UseFileEditorContextMenuControllerOptions) {
  const [clipboardWriteFailed, setClipboardWriteFailed] = useState(false)
  const [menuState, setEditorContextMenu] = useState<FileEditorContextMenuState | null>(null)
  const actionFenceRef = useRef(new RequestOwnershipFence(scope))
  actionFenceRef.current.setScope(scope)
  actionFenceRef.current.setActive(active)
  const editorContextMenu = active && menuState?.scope === scope ? menuState : null

  const closeEditorContextMenu = useCallback(() => {
    actionFenceRef.current.invalidate()
    setEditorContextMenu(null)
  }, [])

  useLayoutEffect(() => {
    setClipboardWriteFailed(false)
    closeEditorContextMenu()
  }, [scope, active, closeEditorContextMenu])

  useLayoutEffect(() => {
    const fence = actionFenceRef.current
    fence.setMounted(true)
    return () => fence.setMounted(false)
  }, [])

  const openContextMenu = useCallback((event: MouseEvent, kind: 'gutter' | 'editor', lineNumber: number) => {
    if (!active) return
    event.preventDefault()
    event.stopPropagation()
    actionFenceRef.current.invalidate()
    onClearBlameDetail()
    onCloseTabContextMenu()
    setEditorContextMenu({
      scope,
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - 220)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - 230)),
      kind,
      lineNumber,
      focusFirstItem: isKeyboardContextMenuEvent(event),
    })
    // The menu owns dismissal immediately. Capability completion only updates
    // available actions; it must never reopen or replace a later menu.
    if (kind === 'gutter' && canShowBlame && !blameOpen) void onCheckBlameCapability()
  }, [active, scope, blameOpen, canShowBlame, onCheckBlameCapability, onClearBlameDetail, onCloseTabContextMenu])

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

    openContextMenu(event.event.browserEvent, kind, lineNumber)
  }, [editorRef, openContextMenu])

  const openBlameContextMenu = useCallback((event: ReactMouseEvent, lineNumber: number) => {
    openContextMenu(event.nativeEvent, 'gutter', lineNumber)
  }, [openContextMenu])

  const runEditorContextAction = useCallback(async (action: FileEditorContextAction) => {
    const editor = editorRef.current
    const menu = editorContextMenu
    closeEditorContextMenu()
    if (!editor || !menu) return
    const actionLease = actionFenceRef.current.begin()
    setClipboardWriteFailed(false)

    if ([
      'go-to-definition',
      'find-references',
      'go-to-implementation',
      'call-hierarchy',
      'type-hierarchy',
      'document-symbols',
      'workspace-symbols',
    ].includes(action)) {
      await onRunLanguageServerAction(action)
      return
    }

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
      const copied = text ? await writeClipboardText(text) : true
      if (!actionLease.isCurrent() || editor.getModel() !== model) return
      if (!copied) {
        setClipboardWriteFailed(true)
        editor.focus()
        return
      }
      if (action === 'cut' && text && !readOnly) {
        editor.executeEdits('farming-context-menu', [{ range: selection, text: '', forceMoveMarkers: true }])
      }
      editor.focus()
      return
    }

    if (action === 'paste' && !readOnly) {
      const text = await navigator.clipboard?.readText().catch(() => '') ?? ''
      if (!actionLease.isCurrent() || editor.getModel() !== model) return
      if (text) {
        editor.executeEdits('farming-context-menu', [{ range: selection, text, forceMoveMarkers: true }])
      }
      editor.focus()
    }
  }, [canShowBlame, canShowLineChanges, closeEditorContextMenu, editorContextMenu, editorRef, onOpenLineChanges, onRunLanguageServerAction, onToggleBlame, readOnly])

  const showBlameContextAction = Boolean(editorContextMenu && editorContextMenu.kind === 'gutter' && canShowBlame && (blameOpen || blameCapability === 'available'))
  const showLineChangesContextActions = Boolean(editorContextMenu && editorContextMenu.kind === 'gutter' && canShowLineChanges)
  const showLanguageServerActions = Boolean(editorContextMenu && editorContextMenu.kind === 'editor' && languageServerAvailable)

  return {
    clipboardWriteFailed,
    editorContextMenu,
    closeEditorContextMenu,
    openEditorContextMenu,
    openBlameContextMenu,
    runEditorContextAction,
    showBlameContextAction,
    showLineChangesContextActions,
    showLanguageServerActions,
  }
}
