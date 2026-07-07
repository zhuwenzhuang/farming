import { type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react'
import { workspaceEditorActionState, type WorkspaceEditorFileMode } from '@/lib/workspace-editor-model'
import type { OpenWorkspaceFile, WorkspaceFileOpenTarget } from '@/lib/workspace-open-files'
import type { CodeCopy } from '../code/copy'
import { FileEditorActions } from './FileEditorActions'
import { FileEditorBreadcrumbs } from './FileEditorBreadcrumbs'
import { FileEditorTabs } from './FileEditorTabs'

interface FileEditorHeaderProps {
  openFile: OpenWorkspaceFile
  openFiles: OpenWorkspaceFile[]
  editorMode: WorkspaceEditorFileMode
  copy: CodeCopy
  statusText: string | null
  onBackToAgent: (agentId: string) => void
  onSelectOpenFile: (agentId: string, filePath: string, target?: WorkspaceFileOpenTarget) => boolean
  canNavigateBack: boolean
  canNavigateForward: boolean
  onNavigateHistory: (direction: -1 | 1) => boolean
  onSetTabRef: (key: string, element: HTMLDivElement | null) => void
  onOpenTabContextMenu: (event: ReactMouseEvent<HTMLDivElement>, index: number) => void
  onTabAuxClick: (event: ReactMouseEvent<HTMLDivElement>, index: number) => void
  onTabKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>, index: number) => void
  onCloseTab: (index: number) => void
  onRevealInExplorer: (agentId: string, filePath: string, kind: 'directory' | 'file') => void
  onSave: (overwrite?: boolean) => void
  onReload: () => void
  onToggleSourcePreview: () => void
  onToggleMarkdownSplit: () => void
  onToggleDiff: () => void
  canPreviewMarkdown: boolean
  canPreviewSource: boolean
  diffOpen: boolean
  markdownSplitOpen: boolean
  sourcePreviewOpen: boolean
}

export function FileEditorHeader({
  openFile,
  openFiles,
  editorMode,
  copy,
  statusText,
  onBackToAgent,
  onSelectOpenFile,
  canNavigateBack,
  canNavigateForward,
  onNavigateHistory,
  onSetTabRef,
  onOpenTabContextMenu,
  onTabAuxClick,
  onTabKeyDown,
  onCloseTab,
  onRevealInExplorer,
  onSave,
  onReload,
  onToggleSourcePreview,
  onToggleMarkdownSplit,
  onToggleDiff,
  canPreviewMarkdown,
  canPreviewSource,
  diffOpen,
  markdownSplitOpen,
  sourcePreviewOpen,
}: FileEditorHeaderProps) {
  const showBreadcrumbs = openFile.file.path.includes('/')
  const actions = workspaceEditorActionState(openFile, editorMode, {
    canPreviewMarkdown,
    canPreviewSource,
    statusText,
    showBreadcrumbs,
  })

  return (
    <header className="code-file-editor-header">
      <FileEditorTabs
        openFile={openFile}
        openFiles={openFiles}
        copy={copy}
        onBackToAgent={onBackToAgent}
        onSelectOpenFile={onSelectOpenFile}
        canNavigateBack={canNavigateBack}
        canNavigateForward={canNavigateForward}
        onNavigateHistory={onNavigateHistory}
        onSetTabRef={onSetTabRef}
        onOpenTabContextMenu={onOpenTabContextMenu}
        onTabAuxClick={onTabAuxClick}
        onTabKeyDown={onTabKeyDown}
        onCloseTab={onCloseTab}
      />
      {actions.showBar && (
        <div className="code-file-editor-bar">
          <FileEditorBreadcrumbs
            openFile={openFile}
            copy={copy}
            onRevealInExplorer={onRevealInExplorer}
          />
          <FileEditorActions
            actions={actions}
            copy={copy}
            diffOpen={diffOpen}
            openFile={openFile}
            markdownSplitOpen={markdownSplitOpen}
            sourcePreviewOpen={sourcePreviewOpen}
            statusText={statusText}
            onReload={onReload}
            onSave={onSave}
            onToggleMarkdownSplit={onToggleMarkdownSplit}
            onToggleSourcePreview={onToggleSourcePreview}
            onToggleDiff={onToggleDiff}
          />
        </div>
      )}
    </header>
  )
}
