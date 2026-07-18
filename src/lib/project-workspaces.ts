const LEGACY_PROJECT_FILES_WORKSPACE_PREFIX = '__farming_project__:'
export const PROJECT_FILES_WORKSPACE_PREFIX = 'wroot_'

const workspaceByRootId = new Map<string, string>()

function normalizeProjectWorkspace(workspace: string) {
  const trimmed = workspace.trim()
  return trimmed === '/' ? trimmed : trimmed.replace(/[\/]+$/, '')
}

function rootIdForWorkspace(workspace: string) {
  const bytes = new TextEncoder().encode(workspace)
  let hash = 0xcbf29ce484222325n
  for (const byte of bytes) {
    hash ^= BigInt(byte)
    hash = BigInt.asUintN(64, hash * 0x100000001b3n)
  }
  return `wroot_${hash.toString(16).padStart(16, '0')}`
}

export function projectFilesWorkspaceId(workspace: string) {
  const normalized = normalizeProjectWorkspace(workspace)
  const rootId = rootIdForWorkspace(normalized)
  workspaceByRootId.set(rootId, normalized)
  return rootId
}

export function projectWorkspaceFromFilesId(filesId: string | null | undefined) {
  const value = String(filesId || '')
  const registered = workspaceByRootId.get(value)
  if (registered) return registered
  if (!value.startsWith(LEGACY_PROJECT_FILES_WORKSPACE_PREFIX)) return ''
  try {
    return normalizeProjectWorkspace(decodeURIComponent(value.slice(LEGACY_PROJECT_FILES_WORKSPACE_PREFIX.length)))
  } catch {
    return ''
  }
}

export function isProjectFilesWorkspaceId(filesId: string | null | undefined) {
  return String(filesId || '').startsWith(PROJECT_FILES_WORKSPACE_PREFIX)
}

// Compatibility aliases for callers that still use the historical name.
export const PROJECT_FILES_AGENT_PREFIX = PROJECT_FILES_WORKSPACE_PREFIX
export const projectFilesAgentId = projectFilesWorkspaceId
export const projectWorkspaceFromFilesAgentId = projectWorkspaceFromFilesId
export const isProjectFilesAgentId = isProjectFilesWorkspaceId

export function normalizeProjectWorkspaces(projects: unknown) {
  if (!Array.isArray(projects)) return []
  const seen = new Set<string>()
  return projects
    .map(project => String(project || '').trim().replace(/[\/]+$/, ''))
    .filter(project => {
      if (!project || project === '/' || seen.has(project)) return false
      seen.add(project)
      return true
    })
}
