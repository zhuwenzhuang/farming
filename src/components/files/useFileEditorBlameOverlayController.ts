import { useCallback, useEffect, useState, type MutableRefObject } from 'react'
import * as monaco from 'monaco-editor'
import {
  DEFAULT_BLAME_LABEL_WIDTH,
  workspaceEditorBlameOverlayRows,
  type WorkspaceEditorBlameOverlayRow,
} from '@/lib/workspace-editor-model'
import type { WorkspaceFileBlame } from '@/lib/workspace-files'

type FileEditorBlameLine = WorkspaceFileBlame['lines'][number]

export interface FileEditorBlameOverlayState {
  viewport: { left: number; top: number; width: number; height: number; stickyHeight: number }
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
    viewport: { left: 0, top: 0, width: 0, height: 0, stickyHeight: 0 },
    left: 0,
    width: DEFAULT_BLAME_LABEL_WIDTH,
    rows: [],
  })

  const refreshBlameOverlay = useCallback(() => {
    const editor = editorRef.current
    const host = editorHostRef.current
    if (!editor || !host || !blameOpen || !blame?.isGitRepo || disabled) {
      setBlameOverlay({ viewport: { left: 0, top: 0, width: 0, height: 0, stickyHeight: 0 }, left: 0, width: DEFAULT_BLAME_LABEL_WIDTH, rows: [] })
      editor?.updateOptions({ lineDecorationsWidth: 10 })
      return
    }

    const compactBlame = host.clientWidth <= 520
    const labelWidth = compactBlame ? blameLabelWidths.compact : blameLabelWidths.regular
    editor.updateOptions({ lineDecorationsWidth: labelWidth + 12 })
    const layout = editor.getLayoutInfo()
    const scrollTop = editor.getScrollTop()
    const lineHeight = editor.getOption(monaco.editor.EditorOption.lineHeight)
    const left = Math.max(0, layout.contentLeft - labelWidth - 8)
    // Sticky headers own their line numbers. Scrolling annotations must not
    // label those fixed lines or escape into the editor header and detail pane.
    const sticky = host.querySelector<HTMLElement>('.sticky-widget')
    const stickyHeight = sticky && sticky.clientHeight > 0
      ? Math.max(0, sticky.getBoundingClientRect().bottom - host.getBoundingClientRect().top)
      : 0
    // Monaco returns separate ranges around folded regions. Merging their
    // endpoints would render hidden lines at the collapsed line's position.
    const rows = editor.getVisibleRanges().flatMap(range => workspaceEditorBlameOverlayRows(blame.lines, {
      firstVisibleLine: range.startLineNumber,
      lastVisibleLine: range.endLineNumber,
      hostTop: 0,
      scrollTop,
      hostHeight: host.clientHeight,
      lineHeight,
      getTopForLineNumber: lineNumber => editor.getTopForLineNumber(lineNumber),
    }))

    setBlameOverlay({
      viewport: { left: host.offsetLeft, top: host.offsetTop, width: host.clientWidth, height: host.clientHeight, stickyHeight },
      left,
      width: labelWidth,
      rows,
    })
  }, [blame, blameLabelWidths, blameOpen, disabled, editorHostRef, editorRef])

  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return undefined

    refreshBlameOverlay()
    let frame: number | undefined
    const scheduleRefresh = () => {
      if (frame !== undefined) window.cancelAnimationFrame(frame)
      frame = window.requestAnimationFrame(() => {
        frame = undefined
        refreshBlameOverlay()
      })
    }
    const scrollSubscription = editor.onDidScrollChange(scheduleRefresh)
    const layoutSubscription = editor.onDidLayoutChange(scheduleRefresh)
    const foldingSubscription = editor.onDidChangeHiddenAreas(scheduleRefresh)
    const configurationSubscription = editor.onDidChangeConfiguration(scheduleRefresh)
    const host = editorHostRef.current
    let stickyResizeObserver: ResizeObserver | undefined
    let stickyMountObserver: MutationObserver | undefined
    if (host && blameOpen && !disabled) {
      // Monaco can resolve sticky headers after the scroll/layout event. Their
      // actual geometry owns the clipping boundary, including a late mount.
      stickyResizeObserver = new ResizeObserver(scheduleRefresh)
      const observeSticky = () => {
        const sticky = host.querySelector('.sticky-widget')
        if (!sticky) return false
        stickyResizeObserver?.observe(sticky)
        stickyMountObserver?.disconnect()
        scheduleRefresh()
        return true
      }
      if (!observeSticky()) {
        stickyMountObserver = new MutationObserver(observeSticky)
        stickyMountObserver.observe(host, { childList: true, subtree: true })
      }
    }
    scheduleRefresh()

    return () => {
      scrollSubscription.dispose()
      layoutSubscription.dispose()
      foldingSubscription.dispose()
      configurationSubscription.dispose()
      stickyResizeObserver?.disconnect()
      stickyMountObserver?.disconnect()
      if (frame !== undefined) window.cancelAnimationFrame(frame)
    }
  }, [blameOpen, disabled, editorHostRef, editorRef, refreshBlameOverlay])

  return {
    blameOverlay,
  }
}
