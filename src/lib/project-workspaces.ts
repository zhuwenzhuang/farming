export const PROJECT_FILES_WORKSPACE_PREFIX = '__farming_project__:'

function normalizeProjectWorkspace(workspace: string) {
  const trimmed = workspace.trim()
  return trimmed === '/' ? trimmed : trimmed.replace(/[\\/]+$/, '')
}

export function projectFilesWorkspaceId(workspace: string) {
  return `${PROJECT_FILES_WORKSPACE_PREFIX}${encodeURIComponent(normalizeProjectWorkspace(workspace))}`
}

export function projectWorkspaceFromFilesId(filesId: string | null | undefined) {
  const value = String(filesId || '')
  if (!value.startsWith(PROJECT_FILES_WORKSPACE_PREFIX)) return ''
  try {
    return normalizeProjectWorkspace(decodeURIComponent(value.slice(PROJECT_FILES_WORKSPACE_PREFIX.length)))
  } catch {
    return ''
  }
}

export function isProjectFilesWorkspaceId(filesId: string | null | undefined) {
  return Boolean(projectWorkspaceFromFilesId(filesId))
}

// The /api/files wire field is still named agentId for compatibility. Keep the
// old exports as aliases while product code uses the workspace-owned identity.
export const PROJECT_FILES_AGENT_PREFIX = PROJECT_FILES_WORKSPACE_PREFIX
export const projectFilesAgentId = projectFilesWorkspaceId
export const projectWorkspaceFromFilesAgentId = projectWorkspaceFromFilesId
export const isProjectFilesAgentId = isProjectFilesWorkspaceId

export function normalizeProjectWorkspaces(projects: unknown) {
  if (!Array.isArray(projects)) return []
  const seen = new Set<string>()
  return projects
    .map(project => String(project || '').trim().replace(/[\\/]+$/, ''))
    .filter(project => {
      if (!project || project === '/' || seen.has(project)) return false
      seen.add(project)
      return true
    })
}
