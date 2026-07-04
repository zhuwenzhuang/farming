import { useRef, useState } from 'react'
import * as monaco from 'monaco-editor'
import {
  isWorkspaceMarkdownFile,
  workspaceEditorFileMode,
  workspaceEditorModelKey,
  workspaceEditorStatusKind,
  workspaceBlameAuthorProfileUrl,
  workspaceEditorTabDomId as fileEditorTabDomId,
} from '@/lib/workspace-editor-model'
import type { OpenWorkspaceFile, WorkspaceFileOpenTarget } from '@/lib/workspace-open-files'
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
  onCloseOpenFile: (agentId: string, filePath: string) => void
  onCloseOpenFiles: (targets: Array<{ agentId: string; filePath: string }>) => void
  onRevealInExplorer: (agentId: string, filePath: string, kind: 'directory' | 'file') => void
  onFocusFilesSearch: (agentId: string) => void
  onRecordNavigationCursor?: (input: WorkspaceNavigationFileInput) => void
  onBackToAgent: (agentId: string) => void
  copy: CodeCopy
}

const BLAME_AUTHOR_URL_TEMPLATE = String(import.meta.env.VITE_FARMING_BLAME_AUTHOR_URL_TEMPLATE || '').trim()

export function FileEditorPane({
  openFile,
  openFiles,
  onChangeDraft,
  onUpdateOpenFile,
  onSelectOpenFile,
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
  const [markdownPreviewByFileKey, setMarkdownPreviewByFileKey] = useState<Record<string, boolean>>({})
  const activeFileKey = workspaceEditorModelKey(openFile)
  const canPreviewMarkdown = !editorMode.preview && !editorMode.diffOnly && isWorkspaceMarkdownFile(openFile.file.path)
  const markdownPreviewOpen = canPreviewMarkdown && markdownPreviewByFileKey[activeFileKey] === true
  const readOnly = !editorMode.canEditText
  const canShowBlame = editorMode.canShowBlame
  const canShowLineChanges = editorMode.canShowLineChanges

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
  const toggleMarkdownPreview = () => {
    if (!canPreviewMarkdown) return
    setMarkdownPreviewByFileKey(previous => ({
      ...previous,
      [activeFileKey]: previous[activeFileKey] !== true,
    }))
  }

  return (
    <section className="code-file-editor" data-testid="code-file-editor" onKeyDownCapture={handleEditorShellKeyDown}>
      <FileEditorHeader
        openFile={openFile}
        openFiles={openFiles}
        editorMode={editorMode}
        copy={copy}
        statusText={statusText}
        onBackToAgent={onBackToAgent}
        onSelectOpenFile={onSelectOpenFile}
        onSetTabRef={setTabRef}
        onOpenTabContextMenu={openEditorTabContextMenu}
        onTabAuxClick={handleEditorTabAuxClick}
        onTabKeyDown={handleEditorTabKeyDown}
        onCloseTab={closeEditorTab}
        onRevealInExplorer={onRevealInExplorer}
        onSave={saveFile}
        onReload={reloadFile}
        onToggleMarkdownPreview={toggleMarkdownPreview}
        onToggleDiff={toggleDiff}
        canPreviewMarkdown={canPreviewMarkdown}
        diffOpen={diffState.open}
        markdownPreviewOpen={markdownPreviewOpen}
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
        markdownPreviewOpen={markdownPreviewOpen}
        openFile={openFile}
        onClearBlameDetail={clearBlameDetail}
        onCloseDiff={closeDiff}
        onCloseLineChanges={closeLineChanges}
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
