import type { WorkspaceFileEntry } from './workspace-files'

export interface WorkspaceDirectorySnapshot {
  items: WorkspaceFileEntry[]
  loading?: boolean
  error?: string | null
  gitStatusPending?: boolean
}

export type WorkspaceDirectoryMap = Record<string, WorkspaceDirectorySnapshot | undefined>

export interface WorkspaceFileTreeNode extends WorkspaceFileEntry {
  id: string
  displayName?: string
  compactedPaths?: string[]
  iconPath?: string
  loading?: boolean
  children?: WorkspaceFileTreeNode[]
}

export function isDescendantPath(parentPath: string, childPath: string) {
  return childPath === parentPath || childPath.startsWith(`${parentPath}/`)
}

export function parentDirectory(filePath: string) {
  const normalized = filePath.replace(/\/+$/, '')
  const index = normalized.lastIndexOf('/')
  return index === -1 ? '' : normalized.slice(0, index)
}

export function ancestorDirectories(filePath: string) {
  const segments = filePath.split('/').filter(Boolean)
  const ancestors: string[] = []
  for (let index = 1; index < segments.length; index += 1) {
    ancestors.push(segments.slice(0, index).join('/'))
  }
  return ancestors
}

export function filePathDepth(filePath: string) {
  return Math.max(0, filePath.split('/').filter(Boolean).length - 1)
}

export function findWorkspaceFileTreeNode(nodes: WorkspaceFileTreeNode[], filePath: string): WorkspaceFileTreeNode | null {
  for (const node of nodes) {
    if (node.path === filePath || node.compactedPaths?.includes(filePath)) return node
    const child = findWorkspaceFileTreeNode(node.children ?? [], filePath)
    if (child) return child
  }
  return null
}

export function findVisibleWorkspaceTreePath(nodes: WorkspaceFileTreeNode[], filePath: string): string | null {
  for (const node of nodes) {
    if (node.path === filePath || node.compactedPaths?.includes(filePath)) return node.path
    const child = findVisibleWorkspaceTreePath(node.children ?? [], filePath)
    if (child) return child
  }
  return null
}

export function visibleWorkspaceDirectoryPathsForTarget(nodes: WorkspaceFileTreeNode[], targetPath: string): string[] {
  for (const node of nodes) {
    if (node.type !== 'directory') continue
    const compactedPaths = node.compactedPaths ?? [node.path]
    const containsTarget = isDescendantPath(node.path, targetPath) ||
      compactedPaths.some(directoryPath => directoryPath === targetPath || isDescendantPath(directoryPath, targetPath))
    if (!containsTarget) continue
    return [node.path, ...visibleWorkspaceDirectoryPathsForTarget(node.children ?? [], targetPath)]
  }
  return []
}

export function visibleWorkspaceDirectoryPathsToOpenForTarget(
  nodes: WorkspaceFileTreeNode[],
  targetPath: string,
  openTargetDirectory = false
): string[] {
  const pathsToOpen = visibleWorkspaceDirectoryPathsForTarget(nodes, targetPath)
  if (openTargetDirectory) {
    const visibleTargetPath = findVisibleWorkspaceTreePath(nodes, targetPath) ?? targetPath
    if (visibleTargetPath) pathsToOpen.push(visibleTargetPath)
  }
  return Array.from(new Set(pathsToOpen.filter(Boolean)))
}

export function countVisibleWorkspaceTreeRows(nodes: WorkspaceFileTreeNode[], openDirectoryPaths: ReadonlySet<string>): number {
  return nodes.reduce((count, node) => {
    if (node.type !== 'directory' || !openDirectoryPaths.has(node.path)) return count + 1
    return count + 1 + countVisibleWorkspaceTreeRows(node.children ?? [], openDirectoryPaths)
  }, 0)
}

export function buildWorkspaceFileTreeNodes(
  items: WorkspaceFileEntry[],
  directories: WorkspaceDirectoryMap
): WorkspaceFileTreeNode[] {
  return items.map(item => {
    if (item.type !== 'directory') {
      return {
        ...item,
        id: item.path,
      }
    }

    let visibleEntry = item
    const compactedNames = [item.name]
    const compactedPaths = [item.path]
    let visibleChildren = directories[item.path]?.items

    while (
      !visibleEntry.symbolicLink &&
      visibleChildren?.length === 1 &&
      visibleChildren[0]?.type === 'directory' &&
      !visibleChildren[0]?.symbolicLink
    ) {
      const child = visibleChildren[0]
      visibleEntry = child
      compactedNames.push(child.name)
      compactedPaths.push(child.path)
      visibleChildren = directories[child.path]?.items
    }
    const loading = compactedPaths.some(directoryPath => directories[directoryPath]?.loading)

    return {
      ...visibleEntry,
      id: visibleEntry.path,
      displayName: compactedNames.join('/'),
      compactedPaths,
      iconPath: compactedPaths[0] ?? visibleEntry.path,
      loading,
      children: buildWorkspaceFileTreeNodes(visibleChildren ?? [], directories),
    }
  })
}
