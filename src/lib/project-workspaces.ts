export const PROJECT_FILES_AGENT_PREFIX = '__farming_project__:'

export function projectFilesAgentId(workspace: string) {
  return `${PROJECT_FILES_AGENT_PREFIX}${encodeURIComponent(workspace.trim())}`
}

export function projectWorkspaceFromFilesAgentId(agentId: string | null | undefined) {
  const value = String(agentId || '')
  if (!value.startsWith(PROJECT_FILES_AGENT_PREFIX)) return ''
  try {
    return decodeURIComponent(value.slice(PROJECT_FILES_AGENT_PREFIX.length)).trim()
  } catch {
    return ''
  }
}

export function isProjectFilesAgentId(agentId: string | null | undefined) {
  return Boolean(projectWorkspaceFromFilesAgentId(agentId))
}

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
