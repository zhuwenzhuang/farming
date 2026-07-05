import { isDescendantPath, type WorkspaceFileTreeNode } from './workspace-file-tree'
import type { WorkspaceFileEntry } from './workspace-files'

const FILE_TREE_INDENT = 12

export type WorkspaceFileTreeStatusTitleKind = 'git' | 'external' | 'dirty'

export interface WorkspaceFileTreeStatusTitleCopy {
  changedOnDisk: string
  containsUncommittedChanges: string
  unsavedChanges: string
}

export function workspaceFileTreeStatusTitle(
  kind: WorkspaceFileTreeStatusTitleKind | null,
  copy: WorkspaceFileTreeStatusTitleCopy
) {
  if (kind === 'git') return copy.containsUncommittedChanges
  if (kind === 'external') return copy.changedOnDisk
  if (kind === 'dirty') return copy.unsavedChanges
  return copy.changedOnDisk
}

export function workspaceFileTreeDepthStyle(depth: number) {
  return {
    '--file-indent': `${4 + depth * FILE_TREE_INDENT}px`,
    '--file-status-indent': `${22 + depth * FILE_TREE_INDENT}px`,
    '--file-guide-width': `${depth * FILE_TREE_INDENT}px`,
    '--file-depth': depth,
  } as Record<string, string | number>
}

export function visibleWorkspaceFileTreeGitStatus(status: WorkspaceFileEntry['gitStatus'] | WorkspaceFileEntry['descendantGitStatus'] | null | undefined) {
  return status === 'untracked' ? undefined : status
}

export function workspaceFileTreeDescendantGitStatusClassName(
  status: WorkspaceFileEntry['descendantGitStatus'] | null | undefined
) {
  const visibleStatus = visibleWorkspaceFileTreeGitStatus(status)
  return visibleStatus ? `code-file-descendant-status ${visibleStatus}` : ''
}

export function hasWorkspaceFileTreeDescendant(paths: ReadonlySet<string>, directoryPath: string) {
  for (const filePath of paths) {
    if (isDescendantPath(directoryPath, filePath)) return true
  }
  return false
}

export interface WorkspaceFileTreeRowViewStateOptions {
  activeFilePath?: string
  editorDirtyFilePaths: ReadonlySet<string>
  editorExternalChangedFilePaths: ReadonlySet<string>
  item: WorkspaceFileTreeNode
  isFocused: boolean
  isOpen: boolean
  isSelected: boolean
}

export function workspaceFileTreeRowViewState({
  activeFilePath,
  editorDirtyFilePaths,
  editorExternalChangedFilePaths,
  item,
  isFocused,
  isOpen,
  isSelected,
}: WorkspaceFileTreeRowViewStateOptions) {
  const isDirectory = item.type === 'directory'
  const active = activeFilePath === item.path
  const directoryLoading = isDirectory && item.loading === true
  const editorDirty = !isDirectory && editorDirtyFilePaths.has(item.path)
  const editorExternalChanged = !isDirectory && editorExternalChangedFilePaths.has(item.path)
  const hasEditorDirtyDescendant = isDirectory && hasWorkspaceFileTreeDescendant(editorDirtyFilePaths, item.path)
  const hasEditorExternalChangedDescendant = isDirectory && hasWorkspaceFileTreeDescendant(editorExternalChangedFilePaths, item.path)
  const visibleGitStatus = visibleWorkspaceFileTreeGitStatus(item.gitStatus)
  const visibleDescendantGitStatus = visibleWorkspaceFileTreeGitStatus(item.descendantGitStatus)
  const visibleGitStatusLabel = visibleGitStatus ? item.gitStatusLabel : undefined
  const hasGitStatus = Boolean(visibleGitStatus)
  const hasDescendantGitStatus = isDirectory && Boolean(visibleDescendantGitStatus)
  const showDirectoryDot = isDirectory && (
    hasDescendantGitStatus || hasEditorDirtyDescendant || hasEditorExternalChangedDescendant
  )
  const directoryDotKind = visibleDescendantGitStatus
    ?? (hasEditorExternalChangedDescendant ? 'external' : hasEditorDirtyDescendant ? 'dirty' : undefined)
  const directoryDotClassName = visibleDescendantGitStatus
    ? workspaceFileTreeDescendantGitStatusClassName(visibleDescendantGitStatus)
    : directoryDotKind
      ? `code-file-descendant-status ${directoryDotKind}`
      : ''
  const directoryDotTitleKind: WorkspaceFileTreeStatusTitleKind | null = hasDescendantGitStatus
    ? 'git'
    : hasEditorExternalChangedDescendant
      ? 'external'
      : hasEditorDirtyDescendant
        ? 'dirty'
        : null
  const fileChangedKind = editorExternalChanged ? 'external' : editorDirty ? 'dirty' : undefined
  const fileChangedClassName = fileChangedKind ? `code-file-changed ${fileChangedKind}` : ''
  const fileChangedTitleKind: WorkspaceFileTreeStatusTitleKind | null = editorExternalChanged
    ? 'external'
    : editorDirty
      ? 'dirty'
      : null
  const visibleGitStatusClassName = visibleGitStatus ? `code-file-git-status ${visibleGitStatus}` : ''
  const chevronState = isDirectory ? (directoryLoading ? 'loading' : isOpen ? 'expanded' : 'collapsed') : 'placeholder'
  const rowClasses = [
    'code-file-row',
    isDirectory ? 'directory' : 'file',
    active ? 'active' : '',
    editorDirty ? 'editor-dirty' : '',
    editorExternalChanged ? 'editor-external-changed' : '',
    hasEditorDirtyDescendant ? 'editor-descendant-dirty' : '',
    hasEditorExternalChangedDescendant ? 'editor-descendant-external-changed' : '',
    isFocused ? 'focused' : '',
    isSelected ? 'selected' : '',
    directoryLoading ? 'loading' : '',
    hasGitStatus ? 'git-status' : '',
    visibleGitStatus ? `git-${visibleGitStatus}` : '',
    hasDescendantGitStatus ? 'git-descendant' : '',
    visibleDescendantGitStatus ? `git-descendant-${visibleDescendantGitStatus}` : '',
  ].filter(Boolean).join(' ')

  return {
    active,
    chevronState,
    directoryLoading,
    directoryDotClassName,
    directoryDotKind,
    directoryDotTitleKind,
    editorDirty,
    editorExternalChanged,
    fileChangedClassName,
    fileChangedKind,
    fileChangedTitleKind,
    hasDescendantGitStatus,
    hasEditorDirtyDescendant,
    hasEditorExternalChangedDescendant,
    isDirectory,
    rowClasses,
    showDirectoryDot,
    visibleGitStatus,
    visibleGitStatusClassName,
    visibleGitStatusLabel,
  }
}

export type WorkspaceFileTreeRowViewState = ReturnType<typeof workspaceFileTreeRowViewState>
