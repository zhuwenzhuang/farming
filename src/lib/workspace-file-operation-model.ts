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

const FILE_CONTEXT_MENU_WIDTH = 220
const FILE_CONTEXT_MENU_MARGIN = 8
const FILE_CONTEXT_MENU_ITEM_HEIGHT = 26
const FILE_CONTEXT_MENU_SEPARATOR_HEIGHT = 11
const FILE_CONTEXT_MENU_PADDING_HEIGHT = 10

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
  viewportHeight: number,
  agentLaunchOptionCount = 0
): Pick<WorkspaceFileContextMenuState, 'x' | 'y'> {
  const menuItems = item ? 7 : 4
  const separators = item ? 4 : 2
  const submenuHeight = agentLaunchOptionCount > 0
    ? FILE_CONTEXT_MENU_PADDING_HEIGHT + agentLaunchOptionCount * FILE_CONTEXT_MENU_ITEM_HEIGHT
    : 0
  const menuHeight = FILE_CONTEXT_MENU_PADDING_HEIGHT
    + menuItems * FILE_CONTEXT_MENU_ITEM_HEIGHT
    + separators * FILE_CONTEXT_MENU_SEPARATOR_HEIGHT
    + submenuHeight
  return {
    x: Math.max(FILE_CONTEXT_MENU_MARGIN, Math.min(x, viewportWidth - FILE_CONTEXT_MENU_WIDTH - FILE_CONTEXT_MENU_MARGIN)),
    y: Math.max(FILE_CONTEXT_MENU_MARGIN, Math.min(y, viewportHeight - menuHeight - FILE_CONTEXT_MENU_MARGIN)),
  }
}
