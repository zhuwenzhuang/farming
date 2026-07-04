import type { WorkspaceFileDeleteResult, WorkspaceFileMove } from './workspace-files'
import { isDescendantPath } from './workspace-file-tree'
import { workspaceFileCacheKey } from './workspace-working-copy'

export interface WorkspaceOpenFileReference {
  agentId: string
  file: { path: string }
  externalChanged: boolean
  error: string | null
}

export function movedWorkspacePath(filePath: string, move: WorkspaceFileMove) {
  if (filePath === move.sourcePath) return move.targetPath
  if (filePath.startsWith(`${move.sourcePath}/`)) {
    return `${move.targetPath}${filePath.slice(move.sourcePath.length)}`
  }
  return null
}

export function movedWorkspacePathByAnyMove(filePath: string, moves: readonly WorkspaceFileMove[]) {
  for (const move of moves) {
    const nextPath = movedWorkspacePath(filePath, move)
    if (nextPath) return nextPath
  }
  return null
}

export function isSameOrDescendantPath(filePath: string, parentPath: string) {
  return isDescendantPath(parentPath, filePath)
}

export function workspaceFileMoveRefreshDirectories(move: WorkspaceFileMove) {
  return [move.sourceDirectory, move.targetDirectory]
}

export function workspaceFileDeleteRefreshDirectories(deletion: WorkspaceFileDeleteResult) {
  return [deletion.parentDirectory]
}

export function workspaceFileMoveFocusPath(move: WorkspaceFileMove) {
  return move.targetPath
}

export function workspaceFileDeleteFocusPath(deletion: WorkspaceFileDeleteResult) {
  return deletion.parentDirectory || null
}

export function applyWorkspaceFileMovesToOpenFile<T extends WorkspaceOpenFileReference>(
  file: T,
  agentId: string,
  moves: readonly WorkspaceFileMove[]
): T {
  if (file.agentId !== agentId) return file
  const nextPath = movedWorkspacePathByAnyMove(file.file.path, moves)
  if (!nextPath) return file
  return {
    ...file,
    file: {
      ...file.file,
      path: nextPath,
    },
    externalChanged: false,
    error: null,
  }
}

export function applyWorkspaceFileMovesToOpenFiles<T extends WorkspaceOpenFileReference>(
  files: readonly T[],
  agentId: string,
  moves: readonly WorkspaceFileMove[]
) {
  return files.map(file => applyWorkspaceFileMovesToOpenFile(file, agentId, moves))
}

export function applyWorkspaceFileMovesToOpenFileCache<T extends WorkspaceOpenFileReference>(
  files: Iterable<T>,
  agentId: string,
  moves: readonly WorkspaceFileMove[]
) {
  const nextCache = new Map<string, T>()
  for (const file of files) {
    const movedFile = applyWorkspaceFileMovesToOpenFile(file, agentId, moves)
    nextCache.set(workspaceFileCacheKey(movedFile.agentId, movedFile.file.path), movedFile)
  }
  return nextCache
}

export function workspaceFileDeletionMatchesOpenFile(
  file: WorkspaceOpenFileReference,
  agentId: string,
  deletions: readonly WorkspaceFileDeleteResult[]
) {
  return file.agentId === agentId &&
    deletions.some(deletion => isSameOrDescendantPath(file.file.path, deletion.path))
}

export function removeWorkspaceFileDeletionsFromOpenFiles<T extends WorkspaceOpenFileReference>(
  files: readonly T[],
  agentId: string,
  deletions: readonly WorkspaceFileDeleteResult[]
) {
  return files.filter(file => !workspaceFileDeletionMatchesOpenFile(file, agentId, deletions))
}

export function removeWorkspaceFileDeletionsFromOpenFileCache<T extends WorkspaceOpenFileReference>(
  files: Iterable<T>,
  agentId: string,
  deletions: readonly WorkspaceFileDeleteResult[]
) {
  const nextCache = new Map<string, T>()
  for (const file of files) {
    if (!workspaceFileDeletionMatchesOpenFile(file, agentId, deletions)) {
      nextCache.set(workspaceFileCacheKey(file.agentId, file.file.path), file)
    }
  }
  return nextCache
}
