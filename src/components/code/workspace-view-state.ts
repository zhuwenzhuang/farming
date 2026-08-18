import type { WorkspaceView } from './types'
import type { WorkspacePluginsNavigationState } from '@/lib/workspace-navigation-history'

const STORAGE_KEY = 'farming.code.workspaceViewState.v1'
const MAX_RESTORE_AGE_MS = 14 * 24 * 60 * 60 * 1000
const MAX_PROJECT_FILE_STATES = 40
const MAX_OPEN_DIRECTORY_PATHS = 120
const MAX_OPEN_FILES = 20
const MAX_COLLAPSED_PROJECT_IDS = 100
const MAX_SIDEBAR_WIDTH = 840
const MIN_SIDEBAR_WIDTH = 220

export type CodeWorkspaceSurface =
  | {
      kind: 'agent'
      agentId?: string
      providerSessionKey?: string
      workspace?: string
    }
  | {
      kind: 'file'
      workspace: string
      filePath: string
      view?: 'editor' | 'diff'
      lineNumber?: number
      column?: number
      endLineNumber?: number
      endColumn?: number
      sourceAgentId?: string
    }

export interface CodeProjectFilesViewState {
  agentsCollapsed?: boolean
  agentVisibleLimit?: number
  changesCollapsed?: boolean
  filesCollapsed?: boolean
  gitHistoryCollapsed?: boolean
  gitHistoryScope?: 'current' | 'all'
  gitHistorySelectedCommitId?: string
  gitHistorySelectedParent?: string
  gitHistoryVisibleLimit?: number
  openChangeDirectoryIds?: string[]
  openEditorsCollapsed?: boolean
  openDirectoryPaths?: string[]
  sessionVisibleLimit?: number
  untrackedChangesCollapsed?: boolean
}

export interface CodeWorkspaceOpenFileViewState {
  column?: number
  endLineNumber?: number
  endColumn?: number
  filePath: string
  lineNumber?: number
  sourceAgentId?: string
  transient?: boolean
  view?: 'editor' | 'diff'
  workspace: string
}

export interface CodeWorkspaceViewState {
  activeTerminalId?: string | null
  activeView?: WorkspaceView
  collapsedComputerAgentIds?: string[]
  collapsedProjectIds?: string[]
  dynamicPinningEnabled?: boolean
  openFiles?: CodeWorkspaceOpenFileViewState[]
  openTerminalIds?: string[]
  pinnedCollapsed?: boolean
  pluginsNavigationState?: WorkspacePluginsNavigationState
  projectListScrollTop?: number
  sidebarCollapsed?: boolean
  sidebarWidth?: number
  surface?: CodeWorkspaceSurface
  projectFiles?: Record<string, CodeProjectFilesViewState>
  usageCollapsed?: boolean
  updatedAt?: number
}

function isWorkspaceView(value: unknown): value is WorkspaceView {
  return value === 'projects' || value === 'search' || value === 'history' || value === 'plugins'
}

function normalizeStringId(value: unknown) {
  return typeof value === 'string' && value.trim() ? value : null
}

function normalizeOpenTerminalIds(value: unknown) {
  if (!Array.isArray(value)) return undefined
  const ids: string[] = []
  const seen = new Set<string>()
  for (const item of value) {
    const id = normalizeStringId(item)
    if (!id || seen.has(id)) continue
    seen.add(id)
    ids.push(id)
    if (ids.length >= 30) break
  }
  return ids
}

function normalizeStringIds(value: unknown, limit: number) {
  if (!Array.isArray(value)) return undefined
  const ids: string[] = []
  const seen = new Set<string>()
  for (const item of value) {
    const id = normalizeStringId(item)
    if (!id || seen.has(id)) continue
    seen.add(id)
    ids.push(id)
    if (ids.length >= limit) break
  }
  return ids
}

function normalizeScrollTop(value: unknown) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Math.max(0, Math.round(value))
}

function normalizePositiveInteger(value: unknown) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Math.max(1, Math.round(value))
}

function normalizeBoundedInteger(value: unknown, minimum: number, maximum: number) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Math.max(minimum, Math.min(maximum, Math.round(value)))
}

function normalizePluginsNavigationState(value: unknown): WorkspacePluginsNavigationState | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  const activeTab = record.activeTab === 'homes' || record.activeTab === 'extensions'
    ? record.activeTab
    : 'farming'
  const selected = record.selectedExtension
  const selectedRecord = selected && typeof selected === 'object'
    ? selected as Record<string, unknown>
    : null
  const homeKey = selectedRecord ? normalizeStringId(selectedRecord.homeKey) : null
  const id = selectedRecord ? normalizeStringId(selectedRecord.id) : null
  const sourceFile = selectedRecord ? normalizeStringId(selectedRecord.sourceFile) : null
  return {
    activeTab,
    activeExtensionHomeKey: normalizeStringId(record.activeExtensionHomeKey) || '',
    activeExtensionKind: normalizeStringId(record.activeExtensionKind) || '',
    extensionQuery: typeof record.extensionQuery === 'string' ? record.extensionQuery.slice(0, 500) : '',
    selectedExtension: homeKey && id && sourceFile ? { homeKey, id, sourceFile } : null,
    scrollTop: normalizeScrollTop(record.scrollTop) ?? 0,
  }
}

function normalizeWorkspaceSurface(value: unknown): CodeWorkspaceSurface | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  if (record.kind === 'agent') {
    const agentId = normalizeStringId(record.agentId) || undefined
    const providerSessionKey = normalizeStringId(record.providerSessionKey) || undefined
    const workspace = normalizeStringId(record.workspace) || undefined
    if (!agentId && !providerSessionKey && !workspace) return undefined
    return { kind: 'agent', agentId, providerSessionKey, workspace }
  }
  if (record.kind !== 'file') return undefined
  const workspace = normalizeStringId(record.workspace)
  const filePath = normalizeStringId(record.filePath)
  if (!workspace || !filePath) return undefined
  return {
    kind: 'file',
    workspace,
    filePath,
    view: record.view === 'diff' ? 'diff' : 'editor',
    lineNumber: normalizePositiveInteger(record.lineNumber),
    column: normalizePositiveInteger(record.column),
    endLineNumber: normalizePositiveInteger(record.endLineNumber),
    endColumn: normalizePositiveInteger(record.endColumn),
    sourceAgentId: normalizeStringId(record.sourceAgentId) || undefined,
  }
}

function normalizeOpenFiles(value: unknown): CodeWorkspaceOpenFileViewState[] | undefined {
  if (!Array.isArray(value)) return undefined
  const files: CodeWorkspaceOpenFileViewState[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const workspace = normalizeStringId(record.workspace)
    const filePath = normalizeStringId(record.filePath)
    if (!workspace || !filePath) continue
    const key = JSON.stringify([workspace, filePath])
    if (seen.has(key)) continue
    seen.add(key)
    files.push({
      workspace,
      filePath,
      view: record.view === 'diff' ? 'diff' : 'editor',
      lineNumber: normalizePositiveInteger(record.lineNumber),
      column: normalizePositiveInteger(record.column),
      endLineNumber: normalizePositiveInteger(record.endLineNumber),
      endColumn: normalizePositiveInteger(record.endColumn),
      sourceAgentId: normalizeStringId(record.sourceAgentId) || undefined,
      transient: typeof record.transient === 'boolean' ? record.transient : undefined,
    })
    if (files.length >= MAX_OPEN_FILES) break
  }
  return files
}

function normalizeProjectFiles(value: unknown) {
  if (!value || typeof value !== 'object') return undefined
  const result: Record<string, CodeProjectFilesViewState> = {}
  Object.entries(value as Record<string, unknown>).slice(-MAX_PROJECT_FILE_STATES).forEach(([workspace, rawState]) => {
    if (!workspace.trim() || !rawState || typeof rawState !== 'object') return
    const state = rawState as Record<string, unknown>
    const openDirectoryPaths = Array.isArray(state.openDirectoryPaths)
      ? Array.from(new Set(state.openDirectoryPaths
        .filter((path): path is string => typeof path === 'string' && Boolean(path.trim()))
        .map(path => path.trim())))
        .slice(0, MAX_OPEN_DIRECTORY_PATHS)
      : undefined
    result[workspace] = {
      agentsCollapsed: typeof state.agentsCollapsed === 'boolean' ? state.agentsCollapsed : undefined,
      agentVisibleLimit: normalizeBoundedInteger(state.agentVisibleLimit, 1, 200),
      changesCollapsed: typeof state.changesCollapsed === 'boolean' ? state.changesCollapsed : undefined,
      filesCollapsed: typeof state.filesCollapsed === 'boolean' ? state.filesCollapsed : undefined,
      gitHistoryCollapsed: typeof state.gitHistoryCollapsed === 'boolean' ? state.gitHistoryCollapsed : undefined,
      gitHistoryScope: state.gitHistoryScope === 'all' ? 'all' : state.gitHistoryScope === 'current' ? 'current' : undefined,
      gitHistorySelectedCommitId: normalizeStringId(state.gitHistorySelectedCommitId) || undefined,
      gitHistorySelectedParent: normalizeStringId(state.gitHistorySelectedParent) || undefined,
      gitHistoryVisibleLimit: normalizeBoundedInteger(state.gitHistoryVisibleLimit, 1, 500),
      openChangeDirectoryIds: normalizeStringIds(state.openChangeDirectoryIds, MAX_OPEN_DIRECTORY_PATHS),
      openEditorsCollapsed: typeof state.openEditorsCollapsed === 'boolean' ? state.openEditorsCollapsed : undefined,
      openDirectoryPaths,
      sessionVisibleLimit: normalizeBoundedInteger(state.sessionVisibleLimit, 1, 200),
      untrackedChangesCollapsed: typeof state.untrackedChangesCollapsed === 'boolean'
        ? state.untrackedChangesCollapsed
        : undefined,
    }
  })
  return Object.keys(result).length > 0 ? result : undefined
}

export function normalizeCodeWorkspaceViewState(value: unknown): CodeWorkspaceViewState {
  if (!value || typeof value !== 'object') return {}
  const record = value as Record<string, unknown>
  const updatedAt = typeof record.updatedAt === 'number' && Number.isFinite(record.updatedAt)
    ? record.updatedAt
    : undefined

  if (updatedAt && Date.now() - updatedAt > MAX_RESTORE_AGE_MS) return {}

  return {
    activeTerminalId: normalizeStringId(record.activeTerminalId),
    activeView: isWorkspaceView(record.activeView) ? record.activeView : undefined,
    collapsedComputerAgentIds: normalizeStringIds(record.collapsedComputerAgentIds, MAX_COLLAPSED_PROJECT_IDS),
    collapsedProjectIds: normalizeStringIds(record.collapsedProjectIds, MAX_COLLAPSED_PROJECT_IDS),
    dynamicPinningEnabled: typeof record.dynamicPinningEnabled === 'boolean' ? record.dynamicPinningEnabled : undefined,
    openFiles: normalizeOpenFiles(record.openFiles),
    openTerminalIds: normalizeOpenTerminalIds(record.openTerminalIds),
    pinnedCollapsed: typeof record.pinnedCollapsed === 'boolean' ? record.pinnedCollapsed : undefined,
    pluginsNavigationState: normalizePluginsNavigationState(record.pluginsNavigationState),
    projectListScrollTop: normalizeScrollTop(record.projectListScrollTop),
    sidebarCollapsed: typeof record.sidebarCollapsed === 'boolean' ? record.sidebarCollapsed : undefined,
    sidebarWidth: normalizeBoundedInteger(record.sidebarWidth, MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH),
    surface: normalizeWorkspaceSurface(record.surface),
    projectFiles: normalizeProjectFiles(record.projectFiles),
    usageCollapsed: typeof record.usageCollapsed === 'boolean' ? record.usageCollapsed : undefined,
    updatedAt,
  }
}

export function loadCodeWorkspaceViewState(): CodeWorkspaceViewState {
  if (typeof window === 'undefined') return {}
  try {
    return normalizeCodeWorkspaceViewState(JSON.parse(window.localStorage.getItem(STORAGE_KEY) || '{}'))
  } catch {
    return {}
  }
}

export function saveCodeWorkspaceViewState(patch: CodeWorkspaceViewState) {
  if (typeof window === 'undefined') return
  try {
    const current = loadCodeWorkspaceViewState()
    const next = normalizeCodeWorkspaceViewState({
      ...current,
      ...patch,
      updatedAt: Date.now(),
    })
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    // Ignore browser storage failures; view restore is a best-effort convenience.
  }
}

export function loadCodeProjectFilesViewState(workspace: string): CodeProjectFilesViewState {
  return loadCodeWorkspaceViewState().projectFiles?.[workspace] ?? {}
}

export function saveCodeProjectFilesViewState(workspace: string, patch: CodeProjectFilesViewState) {
  if (!workspace.trim()) return
  const current = loadCodeWorkspaceViewState()
  const projectFiles = { ...(current.projectFiles ?? {}) }
  delete projectFiles[workspace]
  projectFiles[workspace] = {
    ...current.projectFiles?.[workspace],
    ...patch,
  }
  saveCodeWorkspaceViewState({ projectFiles })
}
