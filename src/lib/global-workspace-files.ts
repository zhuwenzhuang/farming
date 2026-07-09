export const GLOBAL_WORKSPACE_FILES_AGENT_ID = '__farming_global_files__'
export const GLOBAL_WORKSPACE_FILES_PROJECT_ID = '__farming_global_files_project__'
export const GLOBAL_WORKSPACE_FILES_ROOT = '/'

export function isGlobalWorkspaceFilesAgentId(agentId: string | null | undefined) {
  return agentId === GLOBAL_WORKSPACE_FILES_AGENT_ID
}

export function normalizeGlobalWorkspaceFilePath(filePath: string) {
  return String(filePath || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\/+/, '')
}
