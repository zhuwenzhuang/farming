import type { WorkspaceFileEntry } from './workspace-files'

const DIRECTORY_ICON_SIGNAL_MAX_DEPTH = 4
const DIRECTORY_ICON_SIGNAL_LIMIT = 4

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
  iconSignals?: string[]
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

export function countVisibleWorkspaceTreeRows(nodes: WorkspaceFileTreeNode[], openDirectoryPaths: ReadonlySet<string>): number {
  return nodes.reduce((count, node) => {
    if (node.type !== 'directory' || !openDirectoryPaths.has(node.path)) return count + 1
    return count + 1 + countVisibleWorkspaceTreeRows(node.children ?? [], openDirectoryPaths)
  }, 0)
}

function fileExtensionCandidates(fileName: string) {
  const parts = fileName.toLowerCase().split('.').filter(Boolean)
  const candidates: string[] = []

  for (let index = 1; index < parts.length; index += 1) {
    candidates.push(parts.slice(index).join('.'))
  }

  return candidates
}

function collectDirectoryIconSignalCounts(
  directoryPath: string,
  directories: WorkspaceDirectoryMap,
  counts: Map<string, number>,
  seen: Set<string>,
  depth = 0
) {
  if (depth > DIRECTORY_ICON_SIGNAL_MAX_DEPTH || seen.has(directoryPath)) return
  seen.add(directoryPath)

  const directory = directories[directoryPath]
  if (!directory || directory.loading || directory.error) return

  for (const item of directory.items) {
    if (item.type === 'file') {
      for (const extension of fileExtensionCandidates(item.name)) {
        counts.set(extension, (counts.get(extension) ?? 0) + 1)
      }
      continue
    }

    if (item.type === 'directory') {
      collectDirectoryIconSignalCounts(item.path, directories, counts, seen, depth + 1)
    }
  }
}

function directoryIconSignals(
  directoryPath: string,
  directories: WorkspaceDirectoryMap,
  cache: Map<string, string[]>
) {
  const cached = cache.get(directoryPath)
  if (cached) return cached

  const counts = new Map<string, number>()
  collectDirectoryIconSignalCounts(directoryPath, directories, counts, new Set())

  const signals = Array.from(counts.entries())
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, DIRECTORY_ICON_SIGNAL_LIMIT)
    .map(([extension]) => extension)
  cache.set(directoryPath, signals)
  return signals
}

export function buildWorkspaceFileTreeNodes(
  items: WorkspaceFileEntry[],
  directories: WorkspaceDirectoryMap,
  iconSignalCache = new Map<string, string[]>()
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
      visibleChildren?.length === 1 &&
      visibleChildren[0]?.type === 'directory'
    ) {
      const child = visibleChildren[0]
      visibleEntry = child
      compactedNames.push(child.name)
      compactedPaths.push(child.path)
      visibleChildren = directories[child.path]?.items
    }

    return {
      ...visibleEntry,
      id: visibleEntry.path,
      displayName: compactedNames.join('/'),
      compactedPaths,
      iconPath: compactedPaths[0] ?? visibleEntry.path,
      iconSignals: directoryIconSignals(visibleEntry.path, directories, iconSignalCache),
      children: buildWorkspaceFileTreeNodes(visibleChildren ?? [], directories, iconSignalCache),
    }
  })
}
