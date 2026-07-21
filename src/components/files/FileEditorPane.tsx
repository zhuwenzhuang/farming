import { useEffect, useRef, useState } from 'react'
import * as monaco from 'monaco-editor'
import {
  isWorkspaceMarkdownFile,
  isWorkspaceSvgFile,
  workspaceEditorFileMode,
  workspaceEditorModelKey,
  workspaceEditorStatusKind,
  workspaceBlameAuthorProfileUrl,
  workspaceEditorTabDomId as fileEditorTabDomId,
} from '@/lib/workspace-editor-model'
import { isGlobalWorkspaceFilesAgentId } from '@/lib/global-workspace-files'
import type { OpenWorkspaceFile, WorkspaceFileOpenTarget, WorkspaceOpenFileTarget } from '@/lib/workspace-open-files'
import type { WorkspaceNavigationFileInput } from '@/lib/workspace-navigation-history'
import type { CodeCopy } from '../code/copy'
import { FileEditorHeader } from './FileEditorHeader'
import { FileEditorOverlays } from './FileEditorOverlays'
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

export type { OpenWorkspaceFile, WorkspaceFileCursor } from '@/lib/workspace-open-files'

interface FileEditorPaneProps {
  openFile: OpenWorkspaceFile
  openFiles: OpenWorkspaceFile[]
  onChangeDraft: (draft: string) => void
  onUpdateOpenFile: (nextFile: OpenWorkspaceFile) => void
  onSelectOpenFile: (agentId: string, filePath: string, target?: WorkspaceFileOpenTarget) => boolean
  onOpenFilePath: (agentId: string, filePath: string, target?: WorkspaceFileOpenTarget) => Promise<void> | void
  canNavigateBack: boolean
  canNavigateForward: boolean
  onNavigateHistory: (direction: -1 | 1) => boolean
  onCloseOpenFile: (agentId: string, filePath: string, workspaceRoot?: string) => void
  onCloseOpenFiles: (targets: WorkspaceOpenFileTarget[]) => void
  onRevealInExplorer: (agentId: string, filePath: string, kind: 'directory' | 'file') => void
  onFocusFilesSearch: (agentId: string) => void
  onRecordNavigationCursor?: (input: WorkspaceNavigationFileInput) => void
  onBackToAgent: (agentId: string) => void
  copy: CodeCopy
}

const BLAME_AUTHOR_URL_TEMPLATE = String(import.meta.env.VITE_FARMING_BLAME_AUTHOR_URL_TEMPLATE || '').trim()
const WORD_WRAP_STORAGE_KEY = 'farming.code.fileEditor.wordWrap'

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

export function FileEditorPane({
  openFile,
  openFiles,
  onChangeDraft,
  onUpdateOpenFile,
  onSelectOpenFile,
  onOpenFilePath,
  canNavigateBack,
  canNavigateForward,
  onNavigateHistory,
  onCloseOpenFile,
  onCloseOpenFiles,
  onRevealInExplorer,
  onFocusFilesSearch,
  onRecordNavigationCursor,
  onBackToAgent,
  copy,
}: FileEditorPaneProps) {
  const openEditorContextMenuRef = useRef<(event: monaco.editor.IEditorMouseEvent) => void>(() => {})
  const closeEditorContextMenuRef = useRef<() => void>(() => {})
  const activeTabDomId = fileEditorTabDomId(openFile)
  const editorMode = workspaceEditorFileMode(openFile)
  const [sourcePreviewByFileKey, setSourcePreviewByFileKey] = useState<Record<string, boolean>>({})
  const [markdownSplitByFileKey, setMarkdownSplitByFileKey] = useState<Record<string, boolean>>({})
  const [wordWrapEnabled, setWordWrapEnabled] = useState(readWordWrapPreference)
  const activeFileKey = workspaceEditorModelKey(openFile)
  const canPreviewMarkdown = !editorMode.preview && !editorMode.diffOnly && isWorkspaceMarkdownFile(openFile.file.path)
  const canPreviewSource = !editorMode.preview && !editorMode.diffOnly && isWorkspaceSvgFile(openFile.file.path)
  const sourcePreviewPreference = sourcePreviewByFileKey[activeFileKey]
  const sourcePreviewOpen = canPreviewMarkdown || canPreviewSource
    ? sourcePreviewPreference !== false
    : false
  const markdownReadingOpen = canPreviewMarkdown && sourcePreviewOpen
  const markdownSplitOpen = markdownReadingOpen && markdownSplitByFileKey[activeFileKey] === true
  const markdownPreviewOpen = markdownReadingOpen && !markdownSplitOpen
  const sourceVisualPreviewOpen = canPreviewSource && sourcePreviewOpen
  const readOnly = !editorMode.canEditText || isGlobalWorkspaceFilesAgentId(openFile.agentId) || openFile.file.readOnly === true
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
  })

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
    revealLine: revealBlameLine,
  } = useFileEditorMonacoController({
    openFile,
    openFiles,
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
  const markdownPreviewVisible = markdownPreviewOpen && !diffState.open

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
  })
  openEditorContextMenuRef.current = openEditorContextMenu
  closeEditorContextMenuRef.current = closeEditorContextMenu

  const statusText = workspaceEditorStatusKind(openFile) === 'changedOnDisk' ? copy.changedOnDisk : null
  const blameAuthorProfileUrl = blameDetail
    ? workspaceBlameAuthorProfileUrl(blameDetail.line.author, BLAME_AUTHOR_URL_TEMPLATE)
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
      <FileEditorHeader
        openFile={openFile}
        openFiles={openFiles}
        editorMode={editorMode}
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
        onRevealInExplorer={onRevealInExplorer}
        onSave={saveFile}
        onReload={reloadFile}
        onToggleSourcePreview={toggleSourcePreview}
        onToggleMarkdownSplit={toggleMarkdownSplit}
        onToggleWordWrap={toggleWordWrap}
        onToggleDiff={toggleDiff}
        canPreviewMarkdown={canPreviewMarkdown}
        canPreviewSource={canPreviewSource}
        diffOpen={diffState.open}
        markdownPreviewVisible={markdownPreviewVisible}
        markdownSplitOpen={markdownSplitOpen}
        sourcePreviewOpen={sourcePreviewOpen}
        wordWrapEnabled={wordWrapEnabled}
      />

      {openFile.error && (
        <div className="code-file-editor-alert" data-testid="code-file-editor-alert">
          {openFile.error}
        </div>
      )}

      <FileEditorSurface
        activeTabDomId={activeTabDomId}
        blame={blame}
        blameAuthorProfileUrl={blameAuthorProfileUrl}
        blameDetailLine={blameDetail?.line ?? null}
        blameOpen={blameOpen}
        blameOverlay={blameOverlay}
        copy={copy}
        cursorPosition={cursorPosition}
        diffState={diffState}
        editorMode={editorMode}
        editorHostRef={editorHostRef}
        lineChanges={lineChanges}
        markdownSplitOpen={markdownSplitOpen}
        markdownPreviewOpen={markdownPreviewOpen}
        sourcePreviewOpen={sourceVisualPreviewOpen}
        openFile={openFile}
        onClearBlameDetail={clearBlameDetail}
        onCloseDiff={closeDiff}
        onCloseLineChanges={closeLineChanges}
        onOpenFilePath={onOpenFilePath}
        onShowBlameDetail={showBlameDetail}
      />
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
