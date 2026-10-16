import { workspaceEditorActionState, type WorkspaceEditorFileMode } from '@/lib/workspace-editor-model'
import { FileEditorActions } from './FileEditorActions'
import { FileEditorBreadcrumbs } from './FileEditorBreadcrumbs'
import { FileEditorTabs, type FileEditorTabsProps } from './FileEditorTabs'
import type { ShareNoticeAnchor } from '../code/share-notice'

interface FileEditorHeaderProps extends Omit<FileEditorTabsProps, 'actions'> {
  editorMode: WorkspaceEditorFileMode
  readOnly: boolean
  readOnlyBadgeText?: string | null
  readOnlyBadgeTitle?: string
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
  onQuoteCodeSelection?: () => void
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
  readOnlyBadgeText,
  readOnlyBadgeTitle,
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
  onQuoteCodeSelection,
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
            onRevealInExplorer={onRevealInExplorer}
            onCopyReadOnlyShareLink={onCopyReadOnlyShareLink}
            onToggleMarkdownSplit={onToggleMarkdownSplit}
            onToggleMarkdownWideLayout={onToggleMarkdownWideLayout}
            onToggleSourcePreview={onToggleSourcePreview}
            onToggleWordWrap={onToggleWordWrap}
            onToggleDiff={onToggleDiff}
            onQuoteCodeSelection={onQuoteCodeSelection}
            onToggleAgentSidePanel={onToggleAgentSidePanel}
          />
        )}
      />
      {(showBreadcrumbs || readOnlyBadgeText) && (
        <div className="code-file-editor-bar">
          {showBreadcrumbs && (
            <FileEditorBreadcrumbs
              openFile={openFile}
              copy={copy}
              onRevealInExplorer={onRevealInExplorer}
            />
          )}
          {readOnlyBadgeText && (
            <span
              className="code-file-editor-readonly-badge"
              data-testid="code-file-editor-readonly-badge"
              role="status"
              title={readOnlyBadgeTitle || readOnlyBadgeText}
            >
              <svg className="code-file-editor-readonly-badge-icon" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                <rect x="2.5" y="5.5" width="7" height="5" rx="1.25" stroke="currentColor" strokeWidth="1.2" />
                <path d="M4.25 5.5V4a1.75 1.75 0 0 1 3.5 0v1.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
              </svg>
              <span>{readOnlyBadgeText}</span>
            </span>
          )}
        </div>
      )}
    </header>
  )
}
