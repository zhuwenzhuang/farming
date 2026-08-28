import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import * as monaco from 'monaco-editor'
import {
  isWorkspaceHtmlFile,
  isWorkspaceMarkdownFile,
  isWorkspaceSvgFile,
  workspaceEditorFileMode,
  workspaceEditorModelKey,
  workspaceEditorStatusKind,
  workspaceBlameAuthorProfileUrl,
  workspaceBlameCommitUrl,
  workspaceEditorTabDomId as fileEditorTabDomId,
} from '@/lib/workspace-editor-model'
import { isGlobalWorkspaceFilesAgentId } from '@/lib/global-workspace-files'
import type {
  OpenWorkspaceFile,
  WorkspaceFileOpenTarget,
  WorkspaceOpenFileTarget,
  WorkspaceOpenFileUpdater,
} from '@/lib/workspace-open-files'
import type { WorkspaceFileResolveOptions } from '@/lib/workspace-file-model-manager'
import type { WorkspaceFile } from '@/lib/workspace-files'
import type { WorkspaceNavigationFileInput } from '@/lib/workspace-navigation-history'
import {
  workspaceShareAbsolutePath,
  workspaceShareProjectLabel,
  type WorkspaceShareTarget,
} from '@/lib/workspace-share-target'
import type { CodeCopy } from '../code/copy'
import type { ShareNoticeAnchor } from '../code/share-notice'
import { FileEditorHeader } from './FileEditorHeader'
import { FileEditorOverlays } from './FileEditorOverlays'
import { LanguageServerPanel } from './LanguageServerPanel'
import { FileEditorSurface } from './FileEditorSurface'
import { useFileEditorBlameController } from './useFileEditorBlameController'
import { useFileEditorBlameOverlayController } from './useFileEditorBlameOverlayController'
import { useFileEditorContextMenuController } from './useFileEditorContextMenuController'
import { useFileEditorDiffController } from './useFileEditorDiffController'
import { useFileEditorLineChangesController } from './useFileEditorLineChangesController'
import { useFileEditorMonacoController } from './useFileEditorMonacoController'
import { useFileEditorShellKeyboard } from './useFileEditorShellKeyboard'
import { useFileEditorTabsController } from './useFileEditorTabsController'
import { useFileEditorWorkingCopyController } from './useFileEditorWorkingCopyController'
import { useLanguageServerController } from './useLanguageServerController'

export type { OpenWorkspaceFile, WorkspaceFileCursor } from '@/lib/workspace-open-files'

interface FileEditorPaneProps {
  openFile: OpenWorkspaceFile
  globalReadOnly?: boolean
  openFiles: OpenWorkspaceFile[]
  retainedFiles: OpenWorkspaceFile[]
  onChangeDraft: (draft: string) => void
  onUpdateOpenFile: (
    target: WorkspaceOpenFileTarget,
    updater: WorkspaceOpenFileUpdater
  ) => OpenWorkspaceFile | null
  onResolveFile: (
    rootId: string,
    filePath: string,
    options?: WorkspaceFileResolveOptions,
  ) => Promise<WorkspaceFile>
  onSelectOpenFile: (agentId: string, filePath: string, target?: WorkspaceFileOpenTarget) => boolean
  onOpenFilePath: (agentId: string, filePath: string, target?: WorkspaceFileOpenTarget) => Promise<void> | void
  onCopyReadOnlyShareLink: (target: WorkspaceShareTarget, anchor: ShareNoticeAnchor) => Promise<void> | void
  canNavigateBack: boolean
  canNavigateForward: boolean
  onNavigateHistory: (direction: -1 | 1) => boolean
  onCloseOpenFile: (agentId: string, filePath: string, workspaceRoot?: string) => void
  onCloseOpenFiles: (targets: WorkspaceOpenFileTarget[]) => void
  onReorderOpenFile: (sourceKey: string, targetKey: string, position: 'before' | 'after') => void
  onRevealInExplorer: (agentId: string, filePath: string, kind: 'directory' | 'file') => void
  onFocusFilesSearch: (agentId: string) => void
  onRecordNavigationCursor?: (input: WorkspaceNavigationFileInput) => void
  onBackToAgent: (agentId: string) => void
  agentSidePanelOpen: boolean
  onToggleAgentSidePanel?: () => void
  copy: CodeCopy
}

const WORD_WRAP_STORAGE_KEY = 'farming.code.fileEditor.wordWrap'
const LANGUAGE_SERVER_DOCK_WIDTH_STORAGE_KEY = 'farming.code.languageServerDockWidth.v1'
const DEFAULT_LANGUAGE_SERVER_DOCK_WIDTH = 380
const MIN_LANGUAGE_SERVER_DOCK_WIDTH = 320
const MAX_LANGUAGE_SERVER_DOCK_WIDTH = 640
const MIN_LANGUAGE_SERVER_EDITOR_WIDTH = 640
const LANGUAGE_SERVER_DOCK_KEYBOARD_STEP = 16
const MAX_MARKDOWN_READING_POSITIONS = 100

type LanguageServerDockStyle = CSSProperties & {
  '--code-language-server-dock-width'?: string
}

type LanguageServerDockResizeGesture = {
  pointerId: number
  target: HTMLDivElement
  latestWidth: number
}

function readWordWrapPreference() {
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem(WORD_WRAP_STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

function writeWordWrapPreference(enabled: boolean) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(WORD_WRAP_STORAGE_KEY, enabled ? '1' : '0')
  } catch {
    // Ignore unavailable storage; the in-memory toggle still applies.
  }
}

function readLanguageServerDockWidthPreference() {
  if (typeof window === 'undefined') return null
  try {
    const stored = Number(window.localStorage.getItem(LANGUAGE_SERVER_DOCK_WIDTH_STORAGE_KEY))
    if (!Number.isFinite(stored) || stored <= 0) return null
    return Math.round(Math.max(MIN_LANGUAGE_SERVER_DOCK_WIDTH, Math.min(MAX_LANGUAGE_SERVER_DOCK_WIDTH, stored)))
  } catch {
    return null
  }
}

function writeLanguageServerDockWidthPreference(width: number | null) {
  if (typeof window === 'undefined') return
  try {
    if (width === null) window.localStorage.removeItem(LANGUAGE_SERVER_DOCK_WIDTH_STORAGE_KEY)
    else window.localStorage.setItem(LANGUAGE_SERVER_DOCK_WIDTH_STORAGE_KEY, String(Math.round(width)))
  } catch {
    // Ignore unavailable storage; the in-memory width still applies.
  }
}

function clampLanguageServerDockWidth(workbenchWidth: number, width: number) {
  const availableMaximum = Math.max(
    MIN_LANGUAGE_SERVER_DOCK_WIDTH,
    workbenchWidth - MIN_LANGUAGE_SERVER_EDITOR_WIDTH - 1
  )
  const maximum = Math.min(MAX_LANGUAGE_SERVER_DOCK_WIDTH, availableMaximum)
  return Math.round(Math.max(MIN_LANGUAGE_SERVER_DOCK_WIDTH, Math.min(maximum, width)))
}

export function FileEditorPane({
  openFile,
  globalReadOnly = false,
  openFiles,
  retainedFiles,
  onChangeDraft,
  onUpdateOpenFile,
  onResolveFile,
  onSelectOpenFile,
  onOpenFilePath,
  onCopyReadOnlyShareLink,
  canNavigateBack,
  canNavigateForward,
  onNavigateHistory,
  onCloseOpenFile,
  onCloseOpenFiles,
  onReorderOpenFile,
  onRevealInExplorer,
  onFocusFilesSearch,
  onRecordNavigationCursor,
  onBackToAgent,
  agentSidePanelOpen,
  onToggleAgentSidePanel,
  copy,
}: FileEditorPaneProps) {
  const openEditorContextMenuRef = useRef<(event: monaco.editor.IEditorMouseEvent) => void>(() => {})
  const closeEditorContextMenuRef = useRef<() => void>(() => {})
  const languageServerWorkbenchRef = useRef<HTMLDivElement>(null)
  const languageServerDockResizeGestureRef = useRef<LanguageServerDockResizeGesture | null>(null)
  const languageServerDockResizeFrameRef = useRef<number | null>(null)
  const pendingLanguageServerDockClientXRef = useRef<number | null>(null)
  const markdownReadingPositionsRef = useRef(new Map<string, number>())
  const activeTabDomId = fileEditorTabDomId(openFile)
  const editorMode = workspaceEditorFileMode(openFile)
  const [sourcePreviewByFileKey, setSourcePreviewByFileKey] = useState<Record<string, boolean>>({})
  const [markdownSplitByFileKey, setMarkdownSplitByFileKey] = useState<Record<string, boolean>>({})
  const [wordWrapEnabled, setWordWrapEnabled] = useState(readWordWrapPreference)
  const [previewRefreshRevision, setPreviewRefreshRevision] = useState(0)
  const [languageServerDockWidth, setLanguageServerDockWidth] = useState<number | null>(
    readLanguageServerDockWidthPreference
  )
  const languageServerDockWidthRef = useRef(languageServerDockWidth)
  languageServerDockWidthRef.current = languageServerDockWidth
  const activeFileKey = workspaceEditorModelKey(openFile)
  const markdownReadingScrollTop = markdownReadingPositionsRef.current.get(activeFileKey) ?? 0
  const rememberMarkdownReadingPosition = useCallback((scrollTop: number) => {
    const positions = markdownReadingPositionsRef.current
    positions.delete(activeFileKey)
    positions.set(activeFileKey, Math.max(0, scrollTop))
    while (positions.size > MAX_MARKDOWN_READING_POSITIONS) {
      const oldestKey = positions.keys().next().value
      if (typeof oldestKey !== 'string') break
      positions.delete(oldestKey)
    }
  }, [activeFileKey])
  const canPreviewMarkdown = !editorMode.preview && !editorMode.diffOnly && isWorkspaceMarkdownFile(openFile.file.path)
  const canPreviewSource = !editorMode.preview && !editorMode.diffOnly && (
    isWorkspaceSvgFile(openFile.file.path) || isWorkspaceHtmlFile(openFile.file.path)
  )
  const sourcePreviewPreference = sourcePreviewByFileKey[activeFileKey]
  const sourcePreviewOpen = canPreviewMarkdown || canPreviewSource
    ? sourcePreviewPreference !== false
    : false
  const markdownReadingOpen = canPreviewMarkdown && sourcePreviewOpen
  const markdownSplitOpen = markdownReadingOpen && markdownSplitByFileKey[activeFileKey] === true
  const markdownPreviewOpen = markdownReadingOpen && !markdownSplitOpen
  const sourceVisualPreviewOpen = canPreviewSource && sourcePreviewOpen
  const readOnly = globalReadOnly || !editorMode.canEditText || isGlobalWorkspaceFilesAgentId(openFile.agentId) || openFile.file.readOnly === true
  const largeTextPreview = openFile.file.preview?.kind === 'large-text'
    ? openFile.file.preview
    : null
  const canShowBlame = editorMode.canShowBlame && openFile.file.external !== true
  const canShowLineChanges = editorMode.canShowLineChanges && openFile.file.external !== true

  const {
    saveOpenWorkspaceFile,
    saveFile,
    reloadFile,
  } = useFileEditorWorkingCopyController({
    openFile,
    readOnly,
    onUpdateOpenFile,
    resolveFile: onResolveFile,
  })
  const reloadFileAndPreview = useCallback(async () => {
    await reloadFile()
    setPreviewRefreshRevision(revision => revision + 1)
  }, [reloadFile])

  const {
    tabContextMenu,
    pendingClose,
    pendingCloseSaving,
    pendingCloseLabel,
    closeTabContextMenu,
    setTabRef,
    focusEditorTab,
    closeEditorTab,
    openEditorTabContextMenu,
    runTabContextAction,
    handleEditorTabKeyDown,
    handleEditorTabAuxClick,
    confirmSaveAndClose,
    discardAndClose,
    cancelPendingClose,
  } = useFileEditorTabsController({
    openFile,
    openFiles,
    filesLabel: copy.files,
    onSelectOpenFile,
    onCloseOpenFile,
    onCloseOpenFiles,
    onDismissEditorContextMenu: () => closeEditorContextMenuRef.current(),
    onSaveOpenFile: saveOpenWorkspaceFile,
  })

  const handleEditorShellKeyDown = useFileEditorShellKeyboard({
    openFile,
    openFiles,
    onCloseEditorTab: closeEditorTab,
    onFocusEditorTab: focusEditorTab,
    onFocusFilesSearch,
    onSaveFile: saveFile,
  })

  const {
    editorHostRef,
    editorRef,
    cursorPosition,
    modelStatus,
    revealLine: revealBlameLine,
  } = useFileEditorMonacoController({
    openFile,
    openFiles,
    retainedFiles,
    readOnly,
    wordWrapEnabled,
    editorLabel: copy.editorFor(openFile.file.path),
    onChangeDraft,
    onFocusFilesSearch,
    onRecordNavigationCursor,
    onSaveShortcut: () => {
      void saveFile(false)
    },
    onOpenContextMenuRef: openEditorContextMenuRef,
  })

  const languageServer = useLanguageServerController({
    enabled: globalReadOnly !== true,
    openFile,
    openFiles,
    editorRef,
    onOpenFilePath,
    unsupportedMessage: copy.languageServerFeatureUnavailable,
  })

  const clearQueuedLanguageServerDockResize = useCallback(() => {
    pendingLanguageServerDockClientXRef.current = null
    if (languageServerDockResizeFrameRef.current !== null) {
      window.cancelAnimationFrame(languageServerDockResizeFrameRef.current)
      languageServerDockResizeFrameRef.current = null
    }
  }, [])

  const applyLanguageServerDockWidth = useCallback((clientX: number) => {
    const gesture = languageServerDockResizeGestureRef.current
    const workbench = languageServerWorkbenchRef.current
    if (!gesture || !workbench) return
    const bounds = workbench.getBoundingClientRect()
    const nextWidth = clampLanguageServerDockWidth(bounds.width, bounds.right - clientX)
    gesture.latestWidth = nextWidth
    workbench.style.setProperty('--code-language-server-dock-width', `${nextWidth}px`)
    gesture.target.setAttribute('aria-valuenow', String(nextWidth))
  }, [])

  const queueLanguageServerDockWidth = useCallback((clientX: number) => {
    pendingLanguageServerDockClientXRef.current = clientX
    if (languageServerDockResizeFrameRef.current !== null) return
    languageServerDockResizeFrameRef.current = window.requestAnimationFrame(() => {
      languageServerDockResizeFrameRef.current = null
      const pendingClientX = pendingLanguageServerDockClientXRef.current
      pendingLanguageServerDockClientXRef.current = null
      if (pendingClientX !== null) applyLanguageServerDockWidth(pendingClientX)
    })
  }, [applyLanguageServerDockWidth])

  const restoreCommittedLanguageServerDockWidth = useCallback(() => {
    const workbench = languageServerWorkbenchRef.current
    if (!workbench) return
    const committedWidth = languageServerDockWidthRef.current
    if (committedWidth === null) workbench.style.removeProperty('--code-language-server-dock-width')
    else workbench.style.setProperty('--code-language-server-dock-width', `${committedWidth}px`)
  }, [])

  const finishLanguageServerDockResize = useCallback((
    target: HTMLDivElement,
    pointerId: number,
    commit: boolean,
    clientX?: number
  ) => {
    const gesture = languageServerDockResizeGestureRef.current
    if (!gesture || gesture.pointerId !== pointerId) return
    if (clientX !== undefined) applyLanguageServerDockWidth(clientX)
    clearQueuedLanguageServerDockResize()
    languageServerDockResizeGestureRef.current = null
    document.body.classList.remove('code-resizing-language-server-dock')
    if (commit) {
      languageServerDockWidthRef.current = gesture.latestWidth
      setLanguageServerDockWidth(gesture.latestWidth)
      writeLanguageServerDockWidthPreference(gesture.latestWidth)
    } else {
      restoreCommittedLanguageServerDockWidth()
    }
    if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId)
  }, [applyLanguageServerDockWidth, clearQueuedLanguageServerDockResize, restoreCommittedLanguageServerDockWidth])

  const beginLanguageServerDockResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !event.isPrimary || languageServerDockResizeGestureRef.current) return
    const workbench = languageServerWorkbenchRef.current
    const panel = workbench?.querySelector<HTMLElement>('.code-language-server-panel')
    if (!workbench || !panel) return
    event.preventDefault()
    event.currentTarget.focus()
    event.currentTarget.setPointerCapture(event.pointerId)
    languageServerDockResizeGestureRef.current = {
      pointerId: event.pointerId,
      target: event.currentTarget,
      latestWidth: Math.round(panel.getBoundingClientRect().width),
    }
    document.body.classList.add('code-resizing-language-server-dock')
    applyLanguageServerDockWidth(event.clientX)
  }, [applyLanguageServerDockWidth])

  const resizeLanguageServerDockFromKeyboard = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    const workbench = languageServerWorkbenchRef.current
    const panel = workbench?.querySelector<HTMLElement>('.code-language-server-panel')
    if (!workbench || !panel) return
    const bounds = workbench.getBoundingClientRect()
    const currentWidth = panel.getBoundingClientRect().width
    const step = event.shiftKey ? LANGUAGE_SERVER_DOCK_KEYBOARD_STEP * 3 : LANGUAGE_SERVER_DOCK_KEYBOARD_STEP
    let requestedWidth: number
    if (event.key === 'ArrowLeft') requestedWidth = currentWidth + step
    else if (event.key === 'ArrowRight') requestedWidth = currentWidth - step
    else if (event.key === 'Home') requestedWidth = MIN_LANGUAGE_SERVER_DOCK_WIDTH
    else if (event.key === 'End') requestedWidth = MAX_LANGUAGE_SERVER_DOCK_WIDTH
    else return
    event.preventDefault()
    event.stopPropagation()
    const nextWidth = clampLanguageServerDockWidth(bounds.width, requestedWidth)
    workbench.style.setProperty('--code-language-server-dock-width', `${nextWidth}px`)
    languageServerDockWidthRef.current = nextWidth
    setLanguageServerDockWidth(nextWidth)
    writeLanguageServerDockWidthPreference(nextWidth)
  }, [])

  const resetLanguageServerDockWidth = useCallback(() => {
    clearQueuedLanguageServerDockResize()
    languageServerDockResizeGestureRef.current = null
    document.body.classList.remove('code-resizing-language-server-dock')
    languageServerDockWidthRef.current = null
    setLanguageServerDockWidth(null)
    writeLanguageServerDockWidthPreference(null)
    languageServerWorkbenchRef.current?.style.removeProperty('--code-language-server-dock-width')
  }, [clearQueuedLanguageServerDockResize])

  useEffect(() => {
    if (languageServer.navigator.open) return
    const gesture = languageServerDockResizeGestureRef.current
    if (gesture) finishLanguageServerDockResize(gesture.target, gesture.pointerId, false)
  }, [finishLanguageServerDockResize, languageServer.navigator.open])

  useEffect(() => () => {
    clearQueuedLanguageServerDockResize()
    languageServerDockResizeGestureRef.current = null
    document.body.classList.remove('code-resizing-language-server-dock')
  }, [clearQueuedLanguageServerDockResize])

  const {
    blameOpen,
    blameLoading,
    blame,
    blameError,
    blameCapability,
    blameDetail,
    blameLabelWidths,
    checkBlameCapability,
    toggleBlame,
    showBlameDetail,
    clearBlameDetail,
  } = useFileEditorBlameController({
    openFile,
    disabled: !canShowBlame,
    onRevealLine: revealBlameLine,
  })

  const {
    lineChanges,
    openLineChanges,
    closeLineChanges,
  } = useFileEditorLineChangesController({
    openFile,
    disabled: !canShowLineChanges,
    onClearBlameDetail: clearBlameDetail,
    onRevealLine: revealBlameLine,
  })

  const {
    diffState,
    closeDiff,
    toggleDiff,
  } = useFileEditorDiffController({
    openFile,
    diffDisabled: !editorMode.canShowDiff,
    onClearBlameDetail: clearBlameDetail,
  })
  const copyReadOnlyShareLink = useCallback((anchor: ShareNoticeAnchor) => {
    const workspaceRoot = openFile.workspaceRoot || ''
    const target: WorkspaceShareTarget = {
      kind: 'file',
      agentId: openFile.agentId,
      filePath: openFile.file.path,
      ...(workspaceRoot ? { absolutePath: workspaceShareAbsolutePath(workspaceRoot, openFile.file.path) } : {}),
      ...(workspaceRoot ? { projectLabel: workspaceShareProjectLabel(workspaceRoot) } : {}),
      view: diffState.open ? 'diff' : 'editor',
      lineNumber: cursorPosition.lineNumber,
      column: cursorPosition.column,
    }
    void onCopyReadOnlyShareLink(target, anchor)
  }, [cursorPosition.column, cursorPosition.lineNumber, diffState.open, onCopyReadOnlyShareLink, openFile.agentId, openFile.file.path, openFile.workspaceRoot])
  const markdownPreviewVisible = markdownPreviewOpen && !diffState.open
  const visualPreviewVisible = !diffState.open && (sourceVisualPreviewOpen || editorMode.visualPreview)

  const {
    blameOverlay,
  } = useFileEditorBlameOverlayController({
    blame,
    blameLabelWidths,
    blameOpen,
    editorHostRef,
    editorRef,
    disabled: !canShowBlame,
  })

  const {
    editorContextMenu,
    closeEditorContextMenu,
    openEditorContextMenu,
    runEditorContextAction,
    showBlameContextAction,
    showLineChangesContextActions,
    showLanguageServerActions,
  } = useFileEditorContextMenuController({
    blameCapability,
    blameOpen,
    canShowBlame,
    canShowLineChanges,
    editorRef,
    readOnly,
    onCheckBlameCapability: checkBlameCapability,
    onClearBlameDetail: clearBlameDetail,
    onCloseTabContextMenu: closeTabContextMenu,
    onOpenLineChanges: openLineChanges,
    onToggleBlame: toggleBlame,
    languageServerAvailable: languageServer.available,
    onRunLanguageServerAction: languageServer.runAction,
  })
  openEditorContextMenuRef.current = openEditorContextMenu
  closeEditorContextMenuRef.current = closeEditorContextMenu

  const statusText = workspaceEditorStatusKind(openFile) === 'changedOnDisk' ? copy.changedOnDisk : null
  const blameAuthorProfileUrl = blameDetail
    ? workspaceBlameAuthorProfileUrl(blameDetail.line.author, blame?.authorUrlTemplate || '')
    : ''
  const blameCommitUrl = blameDetail
    ? workspaceBlameCommitUrl(blameDetail.line.commit, blame?.commitUrlTemplate || '')
    : ''
  const toggleSourcePreview = () => {
    if (!canPreviewMarkdown && !canPreviewSource) return
    const nextSourcePreviewOpen = !sourcePreviewOpen
    setSourcePreviewByFileKey(previous => ({
      ...previous,
      [activeFileKey]: nextSourcePreviewOpen,
    }))
    if (canPreviewMarkdown && !nextSourcePreviewOpen) {
      setMarkdownSplitByFileKey(previous => ({
        ...previous,
        [activeFileKey]: false,
      }))
    }
  }

  const toggleMarkdownSplit = () => {
    if (!canPreviewMarkdown) return
    setSourcePreviewByFileKey(previous => ({
      ...previous,
      [activeFileKey]: true,
    }))
    setMarkdownSplitByFileKey(previous => ({
      ...previous,
      [activeFileKey]: !markdownSplitOpen,
    }))
  }

  const toggleWordWrap = () => {
    setWordWrapEnabled(current => {
      const next = !current
      writeWordWrapPreference(next)
      return next
    })
  }

  useEffect(() => {
    if (typeof document === 'undefined') return
    document.body.classList.toggle('code-mobile-markdown-reading', markdownReadingOpen)
    return () => {
      document.body.classList.remove('code-mobile-markdown-reading')
    }
  }, [markdownReadingOpen])

  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return undefined
    const frame = window.requestAnimationFrame(() => editor.layout())
    return () => window.cancelAnimationFrame(frame)
  }, [editorRef, markdownSplitOpen, markdownPreviewOpen, sourcePreviewOpen])

  return (
    <section
      className={`code-file-editor ${markdownReadingOpen ? 'markdown-reading' : ''}`.trim()}
      data-testid="code-file-editor"
      onKeyDownCapture={handleEditorShellKeyDown}
    >
      <div className="code-file-editor-workbench-shell">
        <div
          ref={languageServerWorkbenchRef}
          className={`code-file-editor-workbench ${languageServer.navigator.open ? 'navigator-open' : ''}`.trim()}
          data-testid="code-file-editor-workbench"
          style={languageServerDockWidth === null ? undefined : ({
            '--code-language-server-dock-width': `${languageServerDockWidth}px`,
          } as LanguageServerDockStyle)}
        >
          <div className="code-file-editor-main" data-testid="code-file-editor-main">
            <FileEditorHeader
              openFile={openFile}
              openFiles={openFiles}
              editorMode={editorMode}
              readOnly={readOnly}
              copy={copy}
              statusText={statusText}
              onBackToAgent={onBackToAgent}
              onSelectOpenFile={onSelectOpenFile}
              canNavigateBack={canNavigateBack}
              canNavigateForward={canNavigateForward}
              onNavigateHistory={onNavigateHistory}
              onSetTabRef={setTabRef}
              onOpenTabContextMenu={openEditorTabContextMenu}
              onTabAuxClick={handleEditorTabAuxClick}
              onTabKeyDown={handleEditorTabKeyDown}
              onCloseTab={closeEditorTab}
              onReorderOpenFile={onReorderOpenFile}
              onRevealInExplorer={onRevealInExplorer}
              onSave={saveFile}
              onCopyReadOnlyShareLink={copyReadOnlyShareLink}
              onReload={() => { void reloadFileAndPreview() }}
              onToggleSourcePreview={toggleSourcePreview}
              onToggleMarkdownSplit={toggleMarkdownSplit}
              onToggleWordWrap={toggleWordWrap}
              onToggleDiff={toggleDiff}
              agentSidePanelOpen={agentSidePanelOpen}
              onToggleAgentSidePanel={onToggleAgentSidePanel}
              canPreviewMarkdown={canPreviewMarkdown}
              canPreviewSource={canPreviewSource}
              diffOpen={diffState.open}
              previewVisible={markdownPreviewVisible || visualPreviewVisible}
              markdownSplitOpen={markdownSplitOpen}
              sourcePreviewOpen={sourcePreviewOpen}
              wordWrapEnabled={wordWrapEnabled}
            />
            {openFile.error && (
              <div className="code-file-editor-alert" data-testid="code-file-editor-alert">
                {openFile.error}
              </div>
            )}
            {largeTextPreview && (
              <div className="code-file-editor-alert" data-testid="code-file-large-text-alert" role="status">
                {largeTextPreview.truncated ? copy.largeFileTruncated : copy.largeFileReadOnly}
              </div>
            )}
            <FileEditorSurface
              activeTabDomId={activeTabDomId}
              blame={blame}
              blameAuthorProfileUrl={blameAuthorProfileUrl}
              blameCommitUrl={blameCommitUrl}
              blameDetailLine={blameDetail?.line ?? null}
              blameOpen={blameOpen}
              blameOverlay={blameOverlay}
              copy={copy}
              cursorPosition={cursorPosition}
              diffState={diffState}
              editorMode={editorMode}
              editorHostRef={editorHostRef}
              lineChanges={lineChanges}
              modelStatus={modelStatus}
              markdownSplitOpen={markdownSplitOpen}
              markdownPreviewOpen={markdownPreviewOpen}
              sourcePreviewOpen={sourceVisualPreviewOpen}
              previewRefreshRevision={previewRefreshRevision}
              markdownReadingScrollTop={markdownReadingScrollTop}
              openFile={openFile}
              onClearBlameDetail={clearBlameDetail}
              onCloseDiff={closeDiff}
              onCloseLineChanges={closeLineChanges}
              onOpenFilePath={onOpenFilePath}
              onMarkdownReadingPositionChange={rememberMarkdownReadingPosition}
              onShowBlameDetail={showBlameDetail}
            />
          </div>
          {languageServer.navigator.open ? (
            <>
              <div
                className="code-language-server-resizer"
                data-testid="code-language-server-resizer"
                role="separator"
                aria-label={copy.resizeLanguageServerPanel}
                aria-orientation="vertical"
                aria-valuemin={MIN_LANGUAGE_SERVER_DOCK_WIDTH}
                aria-valuemax={MAX_LANGUAGE_SERVER_DOCK_WIDTH}
                aria-valuenow={languageServerDockWidth ?? DEFAULT_LANGUAGE_SERVER_DOCK_WIDTH}
                tabIndex={0}
                title={copy.resizeLanguageServerPanel}
                onPointerDown={beginLanguageServerDockResize}
                onPointerMove={event => {
                  const gesture = languageServerDockResizeGestureRef.current
                  if (!gesture || gesture.pointerId !== event.pointerId) return
                  if (event.pointerType === 'mouse' && event.buttons === 0) {
                    finishLanguageServerDockResize(event.currentTarget, event.pointerId, true, event.clientX)
                    return
                  }
                  event.preventDefault()
                  queueLanguageServerDockWidth(event.clientX)
                }}
                onPointerUp={event => {
                  finishLanguageServerDockResize(event.currentTarget, event.pointerId, true, event.clientX)
                }}
                onPointerCancel={event => {
                  finishLanguageServerDockResize(event.currentTarget, event.pointerId, false)
                }}
                onLostPointerCapture={event => {
                  finishLanguageServerDockResize(event.currentTarget, event.pointerId, false)
                }}
                onDoubleClick={event => {
                  event.preventDefault()
                  resetLanguageServerDockWidth()
                }}
                onKeyDown={resizeLanguageServerDockFromKeyboard}
              />
              <LanguageServerPanel
                state={languageServer.navigator}
                copy={copy}
                onClose={languageServer.closeNavigator}
                onDirection={languageServer.changeDirection}
                onToggleNode={node => void languageServer.toggleNode(node)}
                onOpenNode={languageServer.openNode}
                onSearch={query => void languageServer.searchWorkspaceSymbols(query)}
              />
            </>
          ) : null}
        </div>
      </div>
      <FileEditorOverlays
        blame={blame}
        blameError={blameError}
        blameLoading={blameLoading}
        blameOpen={blameOpen}
        copy={copy}
        editorContextMenu={editorContextMenu}
        readOnly={readOnly}
        openFiles={openFiles}
        pendingCloseOpen={Boolean(pendingClose)}
        pendingCloseLabel={pendingCloseLabel}
        pendingCloseSaving={pendingCloseSaving}
        showBlameContextAction={showBlameContextAction}
        showLineChangesContextActions={showLineChangesContextActions}
        showLanguageServerActions={showLanguageServerActions}
        tabContextMenu={tabContextMenu}
        onCancelPendingClose={cancelPendingClose}
        onCloseEditorContextMenu={closeEditorContextMenu}
        onConfirmSaveAndClose={confirmSaveAndClose}
        onDiscardAndClose={discardAndClose}
        onRunEditorContextAction={runEditorContextAction}
        onRunTabContextAction={runTabContextAction}
      />
    </section>
  )
}
