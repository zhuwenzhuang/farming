import type { RefObject } from 'react'
import type {
  WorkspaceFileContextMenuState as FileContextMenuState,
  WorkspaceFileOperationKind,
} from '@/lib/workspace-file-operation-model'
import type {
  WorkspaceFileJumpQuery,
} from '@/lib/workspace-file-search'
import type { WorkspaceFileSearchMatch } from '@/lib/workspace-files'
import type { AgentLaunchOption } from '../code/agent-launch-options'
import type { CodeCopy } from '../code/copy'
import { FileSearchResults } from './FileSearchResults'
import { workspaceFileTreeDepthStyle } from '@/lib/workspace-file-tree-row'
import { FileSectionOverlays } from './FileSectionOverlays'
import { FileTreeView, type FileTreeViewProps } from './FileTreeView'

export interface FileSectionBodySearch {
  active: boolean
  activeMatchIndex: number
  anchorRef: RefObject<HTMLElement | null>
  error: string | null
  jumpTarget: WorkspaceFileJumpQuery | null
  listboxId: string
  loading: boolean
  matches: WorkspaceFileSearchMatch[]
  query: string
  resultsRef: RefObject<HTMLDivElement | null>
  truncated: boolean
}

export interface FileSectionBodySearchActions {
  onOpenJumpQuery: (query: string) => void
  onOpenMatch: (match: WorkspaceFileSearchMatch) => void
  onSelectMatchIndex: (index: number) => void
}

export type FileSectionBodyTree = Omit<FileTreeViewProps, 'copy'>

interface FileSectionBodyProps {
  copy: CodeCopy
  agentLaunchOptions: AgentLaunchOption[]
  fileMenu: FileContextMenuState | null
  fileMenuRef: RefObject<HTMLDivElement | null>
  openFileError: string | null
  rootDirectoryError: string | null
  rootDirectoryHasItems: boolean
  rootDirectoryLoading: boolean
  search: FileSectionBodySearch
  searchActions: FileSectionBodySearchActions
  tree: FileSectionBodyTree
  onCloseFileMenu: () => void
  onCloseFileMenuWithFocusRestore: () => void
  onCopyFileMenuPath: () => void
  onOpenNewAgentFromFileMenu: () => void
  onRefreshFileMenuTarget: () => void
  onStartAgentFromFileMenu: (command: string) => void
  onStartFileMenuOperation: (kind: WorkspaceFileOperationKind) => void
}

export function FileSectionBody({
  copy,
  agentLaunchOptions,
  fileMenu,
  fileMenuRef,
  openFileError,
  rootDirectoryError,
  rootDirectoryHasItems,
  rootDirectoryLoading,
  search,
  searchActions,
  tree,
  onCloseFileMenu,
  onCloseFileMenuWithFocusRestore,
  onCopyFileMenuPath,
  onOpenNewAgentFromFileMenu,
  onRefreshFileMenuTarget,
  onStartAgentFromFileMenu,
  onStartFileMenuOperation,
}: FileSectionBodyProps) {
  return (
    <>
      {rootDirectoryLoading && !rootDirectoryHasItems && (
        <div className="code-file-status" style={workspaceFileTreeDepthStyle(0)}>{copy.loading}</div>
      )}
      {rootDirectoryError && (
        <div className="code-file-status error" style={workspaceFileTreeDepthStyle(0)}>{rootDirectoryError}</div>
      )}
      {openFileError && !search.active && (
        <div className="code-file-status error" data-testid="code-file-open-error" style={workspaceFileTreeDepthStyle(0)}>
          {openFileError}
        </div>
      )}
      {search.active && (
        <FileSearchResults
          activeMatchIndex={search.activeMatchIndex}
          anchorRef={search.anchorRef}
          containerRef={search.resultsRef}
          copy={copy}
          error={search.error}
          jumpTarget={search.jumpTarget}
          listboxId={search.listboxId}
          loading={search.loading}
          matches={search.matches}
          openFileError={openFileError}
          query={search.query}
          truncated={search.truncated}
          onOpenJumpQuery={searchActions.onOpenJumpQuery}
          onOpenMatch={searchActions.onOpenMatch}
          onSelectMatchIndex={searchActions.onSelectMatchIndex}
        />
      )}
      <FileTreeView
        {...tree}
        copy={copy}
      />
      <FileSectionOverlays
        agentId={tree.agentId}
        copy={copy}
        agentLaunchOptions={agentLaunchOptions}
        fileMenu={fileMenu}
        fileOperation={tree.fileOperation}
        fileMenuRef={fileMenuRef}
        fileOperationInputRef={tree.fileOperationInputRef}
        onCloseFileMenu={onCloseFileMenu}
        onCloseFileMenuWithFocusRestore={onCloseFileMenuWithFocusRestore}
        onCloseFileOperation={tree.onCloseFileOperation}
        onCopyFileMenuPath={onCopyFileMenuPath}
        onOpenNewAgent={onOpenNewAgentFromFileMenu}
        onRefreshFileMenuTarget={onRefreshFileMenuTarget}
        onRememberFileOperationName={tree.onRememberFileOperationName}
        onStartAgent={onStartAgentFromFileMenu}
        onStartFileMenuOperation={onStartFileMenuOperation}
        onSubmitFileOperation={tree.onSubmitFileOperation}
        onUpdateFileOperationName={tree.onUpdateFileOperationName}
      />
    </>
  )
}
