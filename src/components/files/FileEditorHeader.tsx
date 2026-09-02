import { workspaceEditorActionState, type WorkspaceEditorFileMode } from '@/lib/workspace-editor-model'
import { FileEditorActions } from './FileEditorActions'
import { FileEditorBreadcrumbs } from './FileEditorBreadcrumbs'
import { FileEditorTabs, type FileEditorTabsProps } from './FileEditorTabs'
import type { ShareNoticeAnchor } from '../code/share-notice'

interface FileEditorHeaderProps extends Omit<FileEditorTabsProps, 'actions'> {
  editorMode: WorkspaceEditorFileMode
  readOnly: boolean
  statusText: string | null
  onRevealInExplorer: (agentId: string, filePath: string, kind: 'directory' | 'file') => void
  onSave: (overwrite?: boolean) => void
  onCopyReadOnlyShareLink: (anchor: ShareNoticeAnchor) => void
  onReload: () => void
  onToggleSourcePreview: () => void
  onToggleMarkdownSplit: () => void
  onToggleMarkdownWideLayout: () => void
  onToggleWordWrap: () => void
  onToggleDiff: () => void
  agentSidePanelOpen: boolean
  onToggleAgentSidePanel?: () => void
  canPreviewMarkdown: boolean
  canPreviewSource: boolean
  diffOpen: boolean
  previewVisible: boolean
  markdownPreviewVisible: boolean
  markdownWideLayout: boolean
  markdownSplitOpen: boolean
  sourcePreviewOpen: boolean
  wordWrapEnabled: boolean
}

export function FileEditorHeader({
  openFile,
  openFiles,
  editorMode,
  readOnly,
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
  onReorderOpenFile,
  onRevealInExplorer,
  onSave,
  onCopyReadOnlyShareLink,
  onReload,
  onToggleSourcePreview,
  onToggleMarkdownSplit,
  onToggleMarkdownWideLayout,
  onToggleWordWrap,
  onToggleDiff,
  agentSidePanelOpen,
  onToggleAgentSidePanel,
  canPreviewMarkdown,
  canPreviewSource,
  diffOpen,
  previewVisible,
  markdownPreviewVisible,
  markdownWideLayout,
  markdownSplitOpen,
  sourcePreviewOpen,
  wordWrapEnabled,
}: FileEditorHeaderProps) {
  const showBreadcrumbs = Boolean(openFile.file.path) && !previewVisible
  const actions = workspaceEditorActionState(openFile, editorMode, {
    canPreviewMarkdown,
    canPreviewSource,
    markdownPreviewVisible,
    readOnly,
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
        onReorderOpenFile={onReorderOpenFile}
        actions={(
          <FileEditorActions
            actions={actions}
            copy={copy}
            diffOpen={diffOpen}
            markdownWideLayout={markdownWideLayout}
            openFile={openFile}
            markdownSplitOpen={markdownSplitOpen}
            sourcePreviewOpen={sourcePreviewOpen}
            wordWrapEnabled={wordWrapEnabled}
            statusText={statusText}
            agentSidePanelOpen={agentSidePanelOpen}
            onReload={onReload}
            onSave={onSave}
            onCopyReadOnlyShareLink={onCopyReadOnlyShareLink}
            onToggleMarkdownSplit={onToggleMarkdownSplit}
            onToggleMarkdownWideLayout={onToggleMarkdownWideLayout}
            onToggleSourcePreview={onToggleSourcePreview}
            onToggleWordWrap={onToggleWordWrap}
            onToggleDiff={onToggleDiff}
            onToggleAgentSidePanel={onToggleAgentSidePanel}
          />
        )}
      />
      {showBreadcrumbs && (
        <div className="code-file-editor-bar">
          <FileEditorBreadcrumbs
            openFile={openFile}
            copy={copy}
            onRevealInExplorer={onRevealInExplorer}
          />
        </div>
      )}
    </header>
  )
}
