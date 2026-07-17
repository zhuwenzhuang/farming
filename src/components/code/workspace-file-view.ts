export { movedWorkspacePath, isSameOrDescendantPath } from '@/lib/workspace-file-operations'
export { workspaceFileCacheKey } from '@/lib/workspace-working-copy'
export {
  findOpenWorkspaceFile,
  isSameOpenWorkspaceFile,
  refreshOpenWorkspaceFileFromRead,
  replaceOpenWorkspaceFile,
} from '@/lib/workspace-open-files'

export function normalizeTerminalPathText(filePath: string) {
  return filePath.trim().replace(/\\/g, '/')
}

export function normalizeWorkspaceRootText(workspaceRoot: string) {
  return normalizeTerminalPathText(workspaceRoot).replace(/\/+$/, '')
}

export function workspaceHomeRoot(workspaceRoot: string) {
  const normalizedRoot = normalizeWorkspaceRootText(workspaceRoot)
  const match = /^\/Users\/[^/]+/.exec(normalizedRoot)
  return match?.[0] ?? ''
}

export function relativePathInsideWorkspace(absolutePath: string, workspaceRoot: string) {
  const normalizedPath = normalizeTerminalPathText(absolutePath).replace(/\/+$/, '')
  const normalizedRoot = normalizeWorkspaceRootText(workspaceRoot)
  if (!normalizedPath || !normalizedRoot) return null
  const rootAliases = [normalizedRoot]
  if (
    normalizedRoot === '/private/tmp' ||
    normalizedRoot.startsWith('/private/tmp/') ||
    normalizedRoot === '/private/var' ||
    normalizedRoot.startsWith('/private/var/')
  ) {
    rootAliases.push(normalizedRoot.slice('/private'.length))
  } else if (
    normalizedRoot === '/tmp' ||
    normalizedRoot.startsWith('/tmp/') ||
    normalizedRoot === '/var' ||
    normalizedRoot.startsWith('/var/')
  ) {
    rootAliases.push(`/private${normalizedRoot}`)
  }
  for (const root of rootAliases) {
    if (normalizedPath === root) return ''
    const rootPrefix = `${root}/`
    if (normalizedPath.startsWith(rootPrefix)) {
      return normalizedPath.slice(rootPrefix.length)
    }
  }
  return null
}

export function terminalTargetFilePath(targetPath: string, workspaceRoot: string) {
  const normalizedPath = normalizeTerminalPathText(targetPath)
  if (!normalizedPath || normalizedPath.startsWith('../')) return null
  if (normalizedPath.startsWith('./')) {
    return normalizedPath.replace(/^\.\/+/, '')
  }
  if (normalizedPath.startsWith('~/')) {
    const homeRoot = workspaceHomeRoot(workspaceRoot)
    if (!homeRoot) return null
    return relativePathInsideWorkspace(`${homeRoot}/${normalizedPath.slice(2)}`, workspaceRoot)
  }
  if (normalizedPath.startsWith('/')) {
    return relativePathInsideWorkspace(normalizedPath, workspaceRoot)
  }
  return normalizedPath
}
