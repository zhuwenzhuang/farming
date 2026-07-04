import { parentDirectory, type WorkspaceFileTreeNode } from './workspace-file-tree'

export type WorkspaceFileOperationKind = 'new-file' | 'new-folder' | 'rename' | 'delete'

export interface WorkspaceFileContextMenuState {
  x: number
  y: number
  item: WorkspaceFileTreeNode | null
}

export interface WorkspaceFileOperationState {
  kind: WorkspaceFileOperationKind
  item: WorkspaceFileTreeNode | null
  parentPath: string
  name: string
}

export interface WorkspaceFileOperationTitleCopy {
  newFile: string
  newFolder: string
  rename: string
  delete: string
}

export function workspaceFileOperationTargetDirectory(item: WorkspaceFileTreeNode | null) {
  if (!item) return ''
  return item.type === 'directory' ? item.path : parentDirectory(item.path)
}

export function workspaceFileOperationInitialName(kind: WorkspaceFileOperationKind, item: WorkspaceFileTreeNode | null) {
  return kind === 'rename' || kind === 'delete' ? item?.name ?? '' : ''
}

export function createWorkspaceFileOperation(
  kind: WorkspaceFileOperationKind,
  item: WorkspaceFileTreeNode | null
): WorkspaceFileOperationState {
  return {
    kind,
    item,
    parentPath: workspaceFileOperationTargetDirectory(item),
    name: workspaceFileOperationInitialName(kind, item),
  }
}

export function workspaceFileOperationSelectionEnd(operation: WorkspaceFileOperationState) {
  if (operation.kind !== 'rename' || operation.item?.type !== 'file') {
    return operation.name.length
  }

  const extensionIndex = operation.name.lastIndexOf('.')
  return extensionIndex > 0 ? extensionIndex : operation.name.length
}

export function workspaceFileOperationSubmitName(operation: WorkspaceFileOperationState) {
  const name = operation.name.trim()
  if (operation.kind !== 'rename' || operation.item?.type !== 'file') return name
  const extensionIndex = operation.item.name.lastIndexOf('.')
  if (extensionIndex <= 0) return name

  const extension = operation.item.name.slice(extensionIndex)
  return name.endsWith(`${extension}${extension}`)
    ? name.slice(0, -extension.length)
    : name
}

export function workspaceFileOperationTitle(
  operation: WorkspaceFileOperationState,
  copy: WorkspaceFileOperationTitleCopy
) {
  switch (operation.kind) {
    case 'new-file':
      return copy.newFile
    case 'new-folder':
      return copy.newFolder
    case 'rename':
      return copy.rename
    case 'delete':
      return copy.delete
  }
}

export function workspaceFileContextMenuPosition(
  x: number,
  y: number,
  item: WorkspaceFileTreeNode | null,
  viewportWidth: number,
  viewportHeight: number
): Pick<WorkspaceFileContextMenuState, 'x' | 'y'> {
  const menuWidth = 220
  const menuHeight = item ? 190 : 96
  return {
    x: Math.max(8, Math.min(x, viewportWidth - menuWidth - 8)),
    y: Math.max(8, Math.min(y, viewportHeight - menuHeight - 8)),
  }
}
