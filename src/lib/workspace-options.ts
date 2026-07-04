export const MAX_WORKSPACE_OPTIONS = 5

export interface WorkspaceSettings {
  workspace?: string
  lastMainWorkspace?: string
  workspaceHistory?: string[]
}

export function normalizeWorkspaceValue(workspace: string | null | undefined) {
  const value = typeof workspace === 'string' ? workspace.trim() : ''
  if (!value || value === '/' || value === '~') return value
  return value.replace(/[\\/]+$/, '')
}

export function isFarmingInternalWorkspace(workspace: string | null | undefined) {
  const value = normalizeWorkspaceValue(workspace)
  return value === '~/.farming' || /(^|[/\\])\.farming$/.test(value)
}

export function isTemporaryWorkspace(workspace: string | null | undefined) {
  const value = normalizeWorkspaceValue(workspace)
  return value === '/tmp'
    || value.startsWith('/tmp/')
    || value === '/private/tmp'
    || value.startsWith('/private/tmp/')
    || value === '/var/tmp'
    || value.startsWith('/var/tmp/')
    || value === '/private/var/tmp'
    || value.startsWith('/private/var/tmp/')
    || value === '/var/folders'
    || value.startsWith('/var/folders/')
    || value === '/private/var/folders'
    || value.startsWith('/private/var/folders/')
}

export function shouldRememberWorkspace(workspace: string | null | undefined) {
  const value = normalizeWorkspaceValue(workspace)
  return Boolean(value)
    && !isTemporaryWorkspace(value)
    && !isFarmingInternalWorkspace(value)
}

export function buildWorkspaceHistory(workspace: string | null | undefined, history: string[] = []) {
  const merged = [workspace, ...history]
    .map(normalizeWorkspaceValue)
    .filter(entry => shouldRememberWorkspace(entry))
  const deduped: string[] = []
  const seen = new Set<string>()

  merged.forEach((entry) => {
    if (seen.has(entry)) return
    seen.add(entry)
    deduped.push(entry)
  })

  return deduped.slice(0, MAX_WORKSPACE_OPTIONS)
}

export function buildWorkspaceOptions(history: string[] = [], discovered: string[] = []) {
  const deduped: string[] = []
  const seen = new Set<string>()

  ;[...history, ...discovered]
    .map(normalizeWorkspaceValue)
    .filter(entry => shouldRememberWorkspace(entry))
    .forEach((entry) => {
      if (seen.has(entry)) return
      seen.add(entry)
      deduped.push(entry)
    })

  return deduped.slice(0, MAX_WORKSPACE_OPTIONS)
}

export function formatInternalWorkspaceForMain(workspace: string | null | undefined) {
  const value = normalizeWorkspaceValue(workspace)
  if (!value) return ''
  return isFarmingInternalWorkspace(value) ? '~/.farming' : value
}

export function getMainWorkspaceDefault(settings: WorkspaceSettings | null | undefined) {
  const rememberedMain = normalizeWorkspaceValue(settings?.lastMainWorkspace)
  if (rememberedMain) return formatInternalWorkspaceForMain(rememberedMain)

  const configuredWorkspace = normalizeWorkspaceValue(settings?.workspace)
  if (configuredWorkspace) return formatInternalWorkspaceForMain(configuredWorkspace)

  return '~/.farming'
}

export function resolveWorkspaceToStart(
  workspaceInput: string | null | undefined,
  mustStartMain: boolean,
  mainWorkspaceDefault = '~/.farming'
) {
  const normalizedInput = normalizeWorkspaceValue(workspaceInput)
  if (normalizedInput) return normalizedInput
  return mustStartMain ? (normalizeWorkspaceValue(mainWorkspaceDefault) || '~/.farming') : null
}

export function formatWorkspaceForDisplay(workspace: string | null | undefined) {
  const value = normalizeWorkspaceValue(workspace)
  if (!value) return '~/.farming'
  if (isFarmingInternalWorkspace(value)) return '~/.farming'

  const usersPrefix = '/Users/'
  if (value.startsWith(usersPrefix)) {
    const parts = value.split('/')
    if (parts.length > 3) {
      return `~/${parts.slice(3).join('/')}`
    }
  }

  return value
}
