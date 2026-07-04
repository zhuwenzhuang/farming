import { useCallback, useEffect, useState, type MutableRefObject } from 'react'
import * as monaco from 'monaco-editor'
import {
  DEFAULT_BLAME_LABEL_WIDTH,
  workspaceEditorBlameOverlayRows,
  workspaceEditorVisibleLineWindow,
  type WorkspaceEditorBlameOverlayRow,
} from '@/lib/workspace-editor-model'
import type { WorkspaceFileBlame } from '@/lib/workspace-files'

type FileEditorBlameLine = WorkspaceFileBlame['lines'][number]

export interface FileEditorBlameOverlayState {
  left: number
  width: number
  rows: Array<WorkspaceEditorBlameOverlayRow<FileEditorBlameLine>>
}

interface UseFileEditorBlameOverlayControllerOptions {
  blame: WorkspaceFileBlame | null
  blameLabelWidths: {
    compact: number
    regular: number
  }
  blameOpen: boolean
  editorHostRef: MutableRefObject<HTMLDivElement | null>
  editorRef: MutableRefObject<monaco.editor.IStandaloneCodeEditor | null>
  disabled: boolean
}

export function useFileEditorBlameOverlayController({
  blame,
  blameLabelWidths,
  blameOpen,
  editorHostRef,
  editorRef,
  disabled,
}: UseFileEditorBlameOverlayControllerOptions) {
  const [blameOverlay, setBlameOverlay] = useState<FileEditorBlameOverlayState>({
    left: 0,
    width: DEFAULT_BLAME_LABEL_WIDTH,
    rows: [],
  })

  const refreshBlameOverlay = useCallback(() => {
    const editor = editorRef.current
    const host = editorHostRef.current
    if (!editor || !host || !blameOpen || !blame?.isGitRepo || disabled) {
      setBlameOverlay({ left: 0, width: DEFAULT_BLAME_LABEL_WIDTH, rows: [] })
      editor?.updateOptions({ lineDecorationsWidth: 10 })
      return
    }

    const compactBlame = host.clientWidth <= 520
    const labelWidth = compactBlame ? blameLabelWidths.compact : blameLabelWidths.regular
    editor.updateOptions({ lineDecorationsWidth: labelWidth + 12 })
    const layout = editor.getLayoutInfo()
    const hostTop = host.offsetTop
    const scrollTop = editor.getScrollTop()
    const lineHeight = editor.getOption(monaco.editor.EditorOption.lineHeight)
    const left = host.offsetLeft + Math.max(0, layout.contentLeft - labelWidth - 8)
    const visibleWindow = workspaceEditorVisibleLineWindow({
      visibleRanges: editor.getVisibleRanges(),
      scrollTop,
      hostHeight: host.clientHeight,
      lineHeight,
    })
    const rows = workspaceEditorBlameOverlayRows(blame.lines, {
      ...visibleWindow,
      hostTop,
      scrollTop,
      hostHeight: host.clientHeight,
      lineHeight,
      getTopForLineNumber: lineNumber => editor.getTopForLineNumber(lineNumber),
    })

    setBlameOverlay({ left, width: labelWidth, rows })
  }, [blame, blameLabelWidths, blameOpen, disabled, editorHostRef, editorRef])

  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return undefined

    refreshBlameOverlay()
    const scrollSubscription = editor.onDidScrollChange(refreshBlameOverlay)
    const layoutSubscription = editor.onDidLayoutChange(refreshBlameOverlay)
    const frame = window.requestAnimationFrame(refreshBlameOverlay)

    return () => {
      scrollSubscription.dispose()
      layoutSubscription.dispose()
      window.cancelAnimationFrame(frame)
    }
  }, [editorRef, refreshBlameOverlay])

  return {
    blameOverlay,
  }
}
